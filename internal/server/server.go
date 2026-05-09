package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"

	"github.com/axgrid/discovery2/internal/auth"
	"github.com/axgrid/discovery2/internal/cluster"
	"github.com/axgrid/discovery2/internal/health"
	"github.com/axgrid/discovery2/internal/model"
	"github.com/axgrid/discovery2/internal/store"
)

type Config struct {
	Listen string
	Logger *slog.Logger
	UI     fs.FS
}

type Server struct {
	cfg      Config
	log      *slog.Logger
	store    *store.Store
	auth     *auth.Authenticator
	resolver *auth.Resolver
	cluster  *cluster.Cluster
	checker  *health.Checker
	hub      *Hub

	srv *http.Server
}

func New(cfg Config, s *store.Store, a *auth.Authenticator, c *cluster.Cluster, hc *health.Checker) *Server {
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	return &Server{
		cfg:      cfg,
		log:      cfg.Logger,
		store:    s,
		auth:     a,
		resolver: auth.NewResolver(s, a),
		cluster:  c,
		checker:  hc,
		hub:      NewHub(s),
	}
}

func (s *Server) Run(ctx context.Context) error {
	stop := make(chan struct{})
	go s.hub.Run(stop)
	defer close(stop)

	mux := http.NewServeMux()
	s.routes(mux)

	s.srv = &http.Server{
		Addr:              s.cfg.Listen,
		Handler:           withCORS(withLogging(s.log, mux)),
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		<-ctx.Done()
		shutCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = s.srv.Shutdown(shutCtx)
	}()

	s.log.Info("api listening", "addr", s.cfg.Listen)
	if err := s.srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

func (s *Server) routes(mux *http.ServeMux) {
	api := http.NewServeMux()

	// Auth
	api.HandleFunc("POST /v1/auth/login", s.login)
	api.HandleFunc("POST /v1/auth/logout", s.logout)
	api.HandleFunc("GET /v1/auth/me", s.me)

	// Services & instances
	api.HandleFunc("GET /v1/services", s.listServices)
	api.HandleFunc("PUT /v1/services/{name}", s.putService)
	api.HandleFunc("GET /v1/services/{name}", s.getService)
	api.HandleFunc("DELETE /v1/services/{name}", s.deleteService)

	api.HandleFunc("GET /v1/services/{name}/instances", s.listInstances)
	api.HandleFunc("POST /v1/services/{name}/instances", s.registerInstance)
	api.HandleFunc("PUT /v1/services/{name}/instances/{id}", s.upsertInstance)
	api.HandleFunc("GET /v1/services/{name}/instances/{id}", s.getInstance)
	api.HandleFunc("DELETE /v1/services/{name}/instances/{id}", s.deleteInstance)
	api.HandleFunc("POST /v1/services/{name}/instances/{id}/heartbeat", s.heartbeat)
	api.HandleFunc("POST /v1/services/{name}/instances/{id}/check", s.checkInstance)

	// Grants on a service
	api.HandleFunc("POST /v1/services/{name}/grants", s.addGrant)
	api.HandleFunc("DELETE /v1/services/{name}/grants/{userId}", s.removeGrant)

	// Service rename — separate endpoint because it changes the resource key.
	api.HandleFunc("POST /v1/services/{name}/rename", s.renameService)

	// Discovery + cluster + watch
	api.HandleFunc("GET /v1/discover/{name}", s.discover)
	api.HandleFunc("GET /v1/cluster/members", s.clusterMembers)
	api.HandleFunc("POST /v1/cluster/join", s.clusterJoin)
	api.HandleFunc("GET /v1/health", s.healthz)
	api.HandleFunc("GET /v1/watch", s.watch)

	// Users (admin)
	api.HandleFunc("GET /v1/users", s.listUsers)
	api.HandleFunc("POST /v1/users", s.createUser)
	api.HandleFunc("PUT /v1/users/{id}", s.updateUser)
	api.HandleFunc("DELETE /v1/users/{id}", s.deleteUser)

	// Audit (admin)
	api.HandleFunc("GET /v1/audit", s.listAudit)

	// All /v1 routes go through the identity resolver. Per-handler checks
	// enforce admin or per-service ACL. RoleNone here means: attach Identity
	// for the inner handlers, but don't reject anonymous reads at this layer.
	mux.Handle("/v1/", s.resolver.Middleware(auth.RoleNone, api))

	if s.cluster != nil {
		mux.HandleFunc("/cluster/snapshot", s.cluster.HandleSnapshot)
	}
	if s.cfg.UI != nil {
		mux.Handle("/", spaHandler(s.cfg.UI))
	}
}

// --- service handlers ---

func (s *Server) listServices(w http.ResponseWriter, r *http.Request) {
	if !requireRead(w, r) {
		return
	}
	svcs, err := s.store.ListServices()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	if svcs == nil {
		svcs = []model.Service{}
	}
	writeJSON(w, http.StatusOK, svcs)
}

// serviceInput captures the editable fields of a Service. Managed timestamps
// (CreatedAt/UpdatedAt) and the path-bound Name are intentionally excluded
// so empty-string client payloads can't break time-decoding.
type serviceInput struct {
	Description string            `json:"description,omitempty"`
	Tags        []string          `json:"tags,omitempty"`
	Metadata    map[string]string `json:"metadata,omitempty"`
	Visibility  model.Visibility  `json:"visibility,omitempty"`
	OwnerID     string            `json:"ownerId,omitempty"`
	Grants      []string          `json:"grants,omitempty"`
}

func (s *Server) putService(w http.ResponseWriter, r *http.Request) {
	if !requireWrite(w, r) {
		return
	}
	id := auth.IdentityFrom(r.Context())
	name := r.PathValue("name")

	var input serviceInput
	if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}

	existing, err := s.store.GetService(name)
	creating := errors.Is(err, store.ErrNotFound)
	if err != nil && !creating {
		safeStoreErr(w, err)
		return
	}

	svc := model.Service{
		Name:        name,
		Description: input.Description,
		Tags:        input.Tags,
		Metadata:    input.Metadata,
		Visibility:  input.Visibility,
		OwnerID:     input.OwnerID,
		Grants:      input.Grants,
	}

	if !creating {
		if !auth.CanEditService(existing, id) {
			writeErr(w, http.StatusForbidden, errors.New("not allowed to edit this service"))
			return
		}
		// Preserve owner & grants on update unless the caller is admin and
		// explicitly changed them.
		if !id.IsAdmin && !id.System {
			svc.OwnerID = existing.OwnerID
			svc.Grants = existing.Grants
		} else {
			if svc.OwnerID == "" {
				svc.OwnerID = existing.OwnerID
			}
			if svc.Grants == nil {
				svc.Grants = existing.Grants
			}
		}
		svc.CreatedAt = existing.CreatedAt
	} else {
		if svc.OwnerID == "" && id.UserID != "" {
			svc.OwnerID = id.UserID
		}
		if svc.Visibility == "" {
			svc.Visibility = model.VisibilityPublic
		}
	}

	if err := s.store.PutService(&svc); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}

	action := model.AuditServiceUpdated
	if creating {
		action = model.AuditServiceCreated
	}
	s.audit(r, action, name, "service", map[string]interface{}{
		"visibility": svc.Visibility,
		"ownerId":    svc.OwnerID,
	})
	writeJSON(w, http.StatusOK, &svc)
}

// renameService moves a service (and all its instances) to a new name.
type renameRequest struct {
	NewName string `json:"newName"`
}

func (s *Server) renameService(w http.ResponseWriter, r *http.Request) {
	if !requireWrite(w, r) {
		return
	}
	oldName := r.PathValue("name")
	svc, err := s.store.GetService(oldName)
	if err != nil {
		safeStoreErr(w, err)
		return
	}
	id := auth.IdentityFrom(r.Context())
	if !auth.CanEditService(svc, id) {
		writeErr(w, http.StatusForbidden, errors.New("not allowed to rename this service"))
		return
	}
	var req renameRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	renamed, err := s.store.RenameService(oldName, req.NewName)
	if err != nil {
		safeStoreErr(w, err)
		return
	}
	s.audit(r, model.AuditServiceUpdated, renamed.Name, "service", map[string]interface{}{
		"renamedFrom": oldName,
	})
	writeJSON(w, http.StatusOK, renamed)
}

func (s *Server) getService(w http.ResponseWriter, r *http.Request) {
	if !requireRead(w, r) {
		return
	}
	svc, err := s.store.GetService(r.PathValue("name"))
	if err != nil {
		safeStoreErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, svc)
}

func (s *Server) deleteService(w http.ResponseWriter, r *http.Request) {
	if !requireWrite(w, r) {
		return
	}
	name := r.PathValue("name")
	svc, err := s.store.GetService(name)
	if err != nil {
		safeStoreErr(w, err)
		return
	}
	id := auth.IdentityFrom(r.Context())
	if !auth.CanEditService(svc, id) {
		writeErr(w, http.StatusForbidden, errors.New("not allowed to delete this service"))
		return
	}
	if err := s.store.DeleteService(name); err != nil {
		safeStoreErr(w, err)
		return
	}
	s.audit(r, model.AuditServiceDeleted, name, "service", nil)
	w.WriteHeader(http.StatusNoContent)
}

// --- instance handlers ---

func (s *Server) listInstances(w http.ResponseWriter, r *http.Request) {
	if !requireRead(w, r) {
		return
	}
	insts, err := s.store.ListInstances(r.PathValue("name"))
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	if insts == nil {
		insts = []model.Instance{}
	}
	writeJSON(w, http.StatusOK, insts)
}

// instanceInput captures the editable fields of an Instance. Managed
// timestamps (LastHeartbeat / RegisteredAt / UpdatedAt) are excluded so empty
// strings from the UI can't break time decoding.
type instanceInput struct {
	ID               string            `json:"id,omitempty"`
	Address          string            `json:"address"`
	Interfaces       []model.Interface `json:"interfaces,omitempty"`
	Weight           int               `json:"weight,omitempty"`
	Status           model.Status      `json:"status,omitempty"`
	Metadata         map[string]string `json:"metadata,omitempty"`
	TTLSeconds       int               `json:"ttlSeconds,omitempty"`
	CheckMode        model.CheckMode   `json:"checkMode,omitempty"`
	CheckIntervalSec int               `json:"checkIntervalSec,omitempty"`
}

func (in instanceInput) toModel(serviceName, id string) model.Instance {
	return model.Instance{
		ID:               id,
		ServiceName:      serviceName,
		Address:          in.Address,
		Interfaces:       in.Interfaces,
		Weight:           in.Weight,
		Status:           in.Status,
		Metadata:         in.Metadata,
		TTLSeconds:       in.TTLSeconds,
		CheckMode:        in.CheckMode,
		CheckIntervalSec: in.CheckIntervalSec,
	}
}

func (s *Server) registerInstance(w http.ResponseWriter, r *http.Request) {
	if !s.allowInstanceWrite(w, r) {
		return
	}
	name := r.PathValue("name")
	var in instanceInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	id := in.ID
	if id == "" {
		id = uuid.NewString()
	}
	inst := in.toModel(name, id)
	if err := s.store.PutInstance(&inst); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	s.audit(r, model.AuditInstanceUpserted, name, "instance", map[string]interface{}{
		"id":      inst.ID,
		"address": inst.Address,
	})
	writeJSON(w, http.StatusCreated, &inst)
}

func (s *Server) upsertInstance(w http.ResponseWriter, r *http.Request) {
	if !s.allowInstanceWrite(w, r) {
		return
	}
	name := r.PathValue("name")
	id := r.PathValue("id")
	var in instanceInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	inst := in.toModel(name, id)
	if err := s.store.PutInstance(&inst); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	s.audit(r, model.AuditInstanceUpserted, name, "instance", map[string]interface{}{
		"id":      inst.ID,
		"address": inst.Address,
	})
	writeJSON(w, http.StatusOK, &inst)
}

func (s *Server) getInstance(w http.ResponseWriter, r *http.Request) {
	if !requireRead(w, r) {
		return
	}
	inst, err := s.store.GetInstance(r.PathValue("name"), r.PathValue("id"))
	if err != nil {
		safeStoreErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, inst)
}

func (s *Server) deleteInstance(w http.ResponseWriter, r *http.Request) {
	if !s.allowInstanceWrite(w, r) {
		return
	}
	name := r.PathValue("name")
	id := r.PathValue("id")
	if err := s.store.DeleteInstance(name, id); err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	s.audit(r, model.AuditInstanceDeleted, name, "instance", map[string]interface{}{"id": id})
	w.WriteHeader(http.StatusNoContent)
}

type heartbeatReq struct {
	Status model.Status `json:"status,omitempty"`
}

// checkInstance runs an on-demand health probe against the instance and
// applies the resulting status. Returns the per-interface report so the UI
// can show what passed and what didn't.
func (s *Server) checkInstance(w http.ResponseWriter, r *http.Request) {
	if !s.allowInstanceWrite(w, r) {
		return
	}
	if s.checker == nil {
		writeErr(w, http.StatusServiceUnavailable, errors.New("health checker not running"))
		return
	}
	name := r.PathValue("name")
	id := r.PathValue("id")
	inst, err := s.store.GetInstance(name, id)
	if err != nil {
		safeStoreErr(w, err)
		return
	}
	ok, results := s.checker.CheckInstance(r.Context(), inst)
	check := &model.InstanceCheck{
		Timestamp: time.Now().UTC(),
		OK:        ok,
		Mode:      inst.EffectiveCheckMode(),
		Results:   results,
	}
	_ = s.store.SetLastCheck(name, id, check)

	desired := model.StatusUp
	if !ok {
		desired = model.StatusDown
	}
	updated, _ := s.store.SetStatus(name, id, desired)

	type response struct {
		OK      bool                 `json:"ok"`
		Status  model.Status         `json:"status"`
		Mode    model.CheckMode      `json:"mode"`
		Results []health.ProbeResult `json:"results"`
	}
	resp := response{
		OK:      ok,
		Mode:    inst.EffectiveCheckMode(),
		Results: results,
	}
	if updated != nil {
		resp.Status = updated.Status
	} else {
		resp.Status = desired
	}
	writeJSON(w, http.StatusOK, resp)
}

func (s *Server) heartbeat(w http.ResponseWriter, r *http.Request) {
	if !s.allowInstanceWrite(w, r) {
		return
	}
	var req heartbeatReq
	if r.ContentLength > 0 {
		_ = json.NewDecoder(r.Body).Decode(&req)
	}
	inst, err := s.store.Heartbeat(r.PathValue("name"), r.PathValue("id"), req.Status)
	if err != nil {
		safeStoreErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, inst)
}

// allowInstanceWrite enforces service ACL on instance mutations. The parent
// service is auto-created on first instance write (system-owned), so we only
// reject when an existing service refuses the caller.
func (s *Server) allowInstanceWrite(w http.ResponseWriter, r *http.Request) bool {
	if !requireWrite(w, r) {
		return false
	}
	name := r.PathValue("name")
	svc, err := s.store.GetService(name)
	if errors.Is(err, store.ErrNotFound) {
		return true // stub will be created by PutInstance
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return false
	}
	id := auth.IdentityFrom(r.Context())
	if !auth.CanEditService(svc, id) {
		writeErr(w, http.StatusForbidden, errors.New("not allowed to modify this service"))
		return false
	}
	return true
}

// --- discovery / cluster / health ---

func (s *Server) discover(w http.ResponseWriter, r *http.Request) {
	if !requireRead(w, r) {
		return
	}
	insts, err := s.store.ListInstances(r.PathValue("name"))
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	out := make([]model.Instance, 0, len(insts))
	for _, i := range insts {
		if i.Status == model.StatusUp {
			out = append(out, i)
		}
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) clusterMembers(w http.ResponseWriter, r *http.Request) {
	if s.cluster == nil {
		writeJSON(w, http.StatusOK, []string{})
		return
	}
	writeJSON(w, http.StatusOK, s.cluster.Members())
}

type clusterJoinRequest struct {
	Seeds []string `json:"seeds"`
}

func (s *Server) clusterJoin(w http.ResponseWriter, r *http.Request) {
	if !requireAdmin(w, r) {
		return
	}
	if s.cluster == nil {
		writeErr(w, http.StatusServiceUnavailable, errors.New("cluster not configured"))
		return
	}
	var req clusterJoinRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	// Filter out empty entries the UI may send.
	clean := make([]string, 0, len(req.Seeds))
	for _, s := range req.Seeds {
		s = strings.TrimSpace(s)
		if s != "" {
			clean = append(clean, s)
		}
	}
	if len(clean) == 0 {
		writeErr(w, http.StatusBadRequest, errors.New("no seeds provided"))
		return
	}
	n, err := s.cluster.Join(clean)
	if err != nil && n == 0 {
		writeErr(w, http.StatusBadGateway, err)
		return
	}
	s.audit(r, model.AuditServiceUpdated, "cluster", "cluster", map[string]interface{}{
		"action":    "join",
		"seeds":     clean,
		"contacted": n,
	})
	writeJSON(w, http.StatusOK, map[string]any{
		"contacted": n,
		"members":   s.cluster.Members(),
	})
}

func (s *Server) healthz(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "time": time.Now().UTC()})
}

// --- WebSocket watch ---

type wsClient struct {
	conn *websocket.Conn
	send chan model.Event
}

var upgrader = websocket.Upgrader{
	CheckOrigin: func(*http.Request) bool { return true },
}

func (s *Server) watch(w http.ResponseWriter, r *http.Request) {
	if auth.IdentityFrom(r.Context()).Role < auth.RoleRead {
		writeErr(w, http.StatusUnauthorized, errors.New("authentication required"))
		return
	}
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	c := &wsClient{conn: conn, send: make(chan model.Event, 64)}
	s.hub.add(c)
	go s.wsReader(c)
	s.wsWriter(c)
}

func (s *Server) wsReader(c *wsClient) {
	defer func() {
		s.hub.remove(c)
		_ = c.conn.Close()
	}()
	c.conn.SetReadLimit(1 << 16)
	_ = c.conn.SetReadDeadline(time.Now().Add(60 * time.Second))
	c.conn.SetPongHandler(func(string) error {
		_ = c.conn.SetReadDeadline(time.Now().Add(60 * time.Second))
		return nil
	})
	for {
		if _, _, err := c.conn.NextReader(); err != nil {
			return
		}
	}
}

func (s *Server) wsWriter(c *wsClient) {
	ping := time.NewTicker(30 * time.Second)
	defer ping.Stop()
	for {
		select {
		case ev, ok := <-c.send:
			if !ok {
				_ = c.conn.WriteMessage(websocket.CloseMessage, nil)
				return
			}
			_ = c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := c.conn.WriteJSON(ev); err != nil {
				return
			}
		case <-ping.C:
			_ = c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

// --- helpers ---

func requireRead(w http.ResponseWriter, r *http.Request) bool {
	if auth.IdentityFrom(r.Context()).Role >= auth.RoleRead {
		return true
	}
	writeErr(w, http.StatusUnauthorized, errors.New("authentication required"))
	return false
}

func requireWrite(w http.ResponseWriter, r *http.Request) bool {
	if auth.IdentityFrom(r.Context()).Role >= auth.RoleWrite {
		return true
	}
	writeErr(w, http.StatusForbidden, errors.New("write access required"))
	return false
}

// requireRole is kept for tests that use the old auth.Authenticator.Middleware path.
func requireRole(w http.ResponseWriter, r *http.Request, min auth.Role) bool {
	if auth.RoleFrom(r.Context()) >= min {
		return true
	}
	writeErr(w, http.StatusForbidden, fmt.Errorf("role %s required", min))
	return false
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, err error) {
	writeJSON(w, code, map[string]string{"error": err.Error()})
}

func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		// Cookies require an explicit origin (not "*") + credentials. The UI
		// is served from the same origin, so echo it back.
		if origin := r.Header.Get("Origin"); origin != "" {
			h.Set("Access-Control-Allow-Origin", origin)
			h.Set("Vary", "Origin")
		} else {
			h.Set("Access-Control-Allow-Origin", "*")
		}
		h.Set("Access-Control-Allow-Credentials", "true")
		h.Set("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS")
		h.Set("Access-Control-Allow-Headers", "Authorization,Content-Type,X-API-Token")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func withLogging(log *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rw := &statusRecorder{ResponseWriter: w, status: 200}
		next.ServeHTTP(rw, r)
		if !strings.HasPrefix(r.URL.Path, "/assets/") && r.URL.Path != "/v1/watch" {
			log.Info("http",
				"method", r.Method,
				"path", r.URL.Path,
				"status", rw.status,
				"dur", time.Since(start).String(),
			)
		}
	})
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(code int) {
	r.status = code
	r.ResponseWriter.WriteHeader(code)
}

func spaHandler(fsys fs.FS) http.Handler {
	fileServer := http.FileServer(http.FS(fsys))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		clean := strings.TrimPrefix(r.URL.Path, "/")
		if clean == "" {
			clean = "index.html"
		}
		if _, err := fs.Stat(fsys, clean); err != nil {
			r.URL.Path = "/"
			data, err := fs.ReadFile(fsys, "index.html")
			if err != nil {
				http.Error(w, "ui not built", http.StatusNotFound)
				return
			}
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			_, _ = w.Write(data)
			return
		}
		fileServer.ServeHTTP(w, r)
	})
}
