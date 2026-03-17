package main

import (
	"context"
	"embed"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/warpstreamlabs/bento/public/bloblang"
)

//go:embed index.html styles.css app.js schema.json
var staticFiles embed.FS

var bentoURL string

func main() {
	port := flag.Int("port", 8080, "Server port")
	flag.StringVar(&bentoURL, "bento", "http://localhost:4195", "Bento API URL")
	flag.Parse()

	http.HandleFunc("/", handleStatic)

	// Proxy Streams API to Bento
	http.HandleFunc("/streams", handleProxy)
	http.HandleFunc("/streams/", handleProxy)

	// Native Bloblang Playground Endpoints
	http.HandleFunc("/execute", handleExecute)
	http.HandleFunc("/syntax", handleSyntax) // New endpoint for dynamic autocomplete

	addr := fmt.Sprintf("0.0.0.0:%d", *port)
	server := &http.Server{Addr: addr}

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		<-stop
		log.Println("Shutting down server...")
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := server.Shutdown(ctx); err != nil {
			log.Printf("Server shutdown error: %v", err)
		}
	}()

	log.Printf("BentoViz serving on http://0.0.0.0:%d", *port)
	log.Printf("Proxying streams to Bento at %s", bentoURL)
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}

// --- Syntax Generation for Auto-complete ---

type SyntaxSpec struct {
	Name        string `json:"name"`
	Description string `json:"description"`
}

type SyntaxPayload struct {
	Keywords  []SyntaxSpec          `json:"keywords"`
	Functions map[string]SyntaxSpec `json:"functions"`
	Methods   map[string]SyntaxSpec `json:"methods"`
}

func handleSyntax(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	if r.Method == "OPTIONS" {
		w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
		w.WriteHeader(http.StatusOK)
		return
	}

	payload := SyntaxPayload{
		Keywords: []SyntaxSpec{
			{"root", "The root of the output document"},
			{"this", "The current context value"},
			{"if", "Conditional expression"},
			{"else", "Alternative branch"},
			{"match", "Pattern matching expression"},
			{"let", "Variable assignment"},
			{"meta", "Access or mutate message metadata"},
			{"error", "Throw a custom error"},
		},
		Functions: make(map[string]SyntaxSpec),
		Methods:   make(map[string]SyntaxSpec),
	}

	// Walk the global environment to capture all standard + custom plugin functions
	env := bloblang.GlobalEnvironment()

	env.WalkFunctions(func(name string, view *bloblang.FunctionView) {
		payload.Functions[name] = SyntaxSpec{
			Name:        name,
			Description: view.Description(),
		}
	})

	env.WalkMethods(func(name string, view *bloblang.MethodView) {
		payload.Methods[name] = SyntaxSpec{
			Name:        name,
			Description: view.Description(),
		}
	})

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(payload)
}

// --- Execution Engine ---

type ExecuteRequest struct {
	Input   string `json:"input"`
	Mapping string `json:"mapping"`
}

type ExecuteResponse struct {
	Result       interface{} `json:"result,omitempty"`
	MappingError string      `json:"mapping_error,omitempty"`
	ParseError   string      `json:"parse_error,omitempty"`
}

func handleExecute(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")

	if r.Method == "OPTIONS" {
		w.WriteHeader(http.StatusOK)
		return
	}

	var req ExecuteRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid payload", http.StatusBadRequest)
		return
	}

	resp := ExecuteResponse{}
	w.Header().Set("Content-Type", "application/json")

	// Parse Mapping
	exe, err := bloblang.Parse(req.Mapping)
	if err != nil {
		resp.ParseError = err.Error()
		json.NewEncoder(w).Encode(resp)
		return
	}

	// Parse Input JSON
	var inputVal interface{}
	if strings.TrimSpace(req.Input) != "" {
		if err := json.Unmarshal([]byte(req.Input), &inputVal); err != nil {
			resp.MappingError = "Invalid Test Input JSON: " + err.Error()
			json.NewEncoder(w).Encode(resp)
			return
		}
	} else {
		inputVal = map[string]interface{}{}
	}

	// Execute
	res, err := exe.Query(inputVal)
	if err != nil {
		resp.MappingError = err.Error()
		json.NewEncoder(w).Encode(resp)
		return
	}

	resp.Result = res
	json.NewEncoder(w).Encode(resp)
}

// --- Standard Proxy & Static Assets ---

func handleProxy(w http.ResponseWriter, r *http.Request) {
	if r.Method == "OPTIONS" {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		w.WriteHeader(http.StatusOK)
		return
	}

	bentoPath := r.URL.Path
	var reqBody io.Reader
	if r.Method == "POST" || r.Method == "PUT" {
		reqBody = r.Body
	}

	req, _ := http.NewRequest(r.Method, bentoURL+bentoPath, reqBody)
	for key, values := range r.Header {
		if !strings.EqualFold(key, "Origin") && !strings.EqualFold(key, "Referer") {
			for _, v := range values {
				req.Header.Add(key, v)
			}
		}
	}
	if r.Method == "POST" || r.Method == "PUT" {
		req.Header.Set("Content-Type", "application/json")
	}

	client := &http.Client{}
	resp, err := client.Do(req)
	if err != nil {
		http.Error(w, "Bento unreachable: "+err.Error(), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	for k, v := range resp.Header {
		for _, val := range v {
			w.Header().Add(k, val)
		}
	}
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.WriteHeader(resp.StatusCode)
	io.Copy(w, resp.Body)
}

func handleStatic(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" {
		return
	}
	path := r.URL.Path
	if path == "/" {
		path = "/index.html"
	}
	path = strings.TrimPrefix(path, "/")
	content, err := staticFiles.ReadFile(path)
	if err != nil {
		http.Error(w, "Not found", http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", getContentType(path))
	w.Write(content)
}

func getContentType(path string) string {
	if strings.HasSuffix(path, ".html") {
		return "text/html; charset=utf-8"
	}
	if strings.HasSuffix(path, ".css") {
		return "text/css; charset=utf-8"
	}
	if strings.HasSuffix(path, ".js") {
		return "application/javascript; charset=utf-8"
	}
	return "application/json"
}
