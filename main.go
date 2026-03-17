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

// staticFiles embeds the web UI files
//
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

	// Native Bloblang Playground Execution
	http.HandleFunc("/execute", handleExecute)

	addr := fmt.Sprintf("0.0.0.0:%d", *port)
	server := &http.Server{Addr: addr}

	// Channel to listen for shutdown signals
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)

	// Goroutine to listen for shutdown signal
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

// ExecuteRequest represents the payload from the playground UI
type ExecuteRequest struct {
	Input   string `json:"input"`
	Mapping string `json:"mapping"`
}

// ExecuteResponse is sent back to the playground UI
type ExecuteResponse struct {
	Result       interface{} `json:"result,omitempty"`
	MappingError string      `json:"mapping_error,omitempty"`
	ParseError   string      `json:"parse_error,omitempty"`
}

func handleExecute(w http.ResponseWriter, r *http.Request) {
	// CORS handling for playground
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")

	if r.Method == "OPTIONS" {
		w.WriteHeader(http.StatusOK)
		return
	}

	if r.Method != "POST" {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req ExecuteRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid JSON payload", http.StatusBadRequest)
		return
	}

	resp := ExecuteResponse{}
	w.Header().Set("Content-Type", "application/json")

	// 1. Parse the Bloblang mapping
	exe, err := bloblang.Parse(req.Mapping)
	if err != nil {
		resp.ParseError = err.Error()
		json.NewEncoder(w).Encode(resp)
		return
	}

	// 2. Parse the input JSON test data
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

	// 3. Execute the Bloblang mapping against the input
	res, err := exe.Query(inputVal)
	if err != nil {
		resp.MappingError = err.Error()
		json.NewEncoder(w).Encode(resp)
		return
	}

	// 4. Send successful result
	resp.Result = res
	json.NewEncoder(w).Encode(resp)
}

func handleProxy(w http.ResponseWriter, r *http.Request) {
	if r.Method == "OPTIONS" {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		w.WriteHeader(http.StatusOK)
		return
	}

	bentoPath := r.URL.Path
	method := r.Method

	var reqBody io.Reader
	if method == "POST" || method == "PUT" {
		reqBody = r.Body
	}

	req, err := http.NewRequest(method, bentoURL+bentoPath, reqBody)
	if err != nil {
		http.Error(w, "Failed to create request: "+err.Error(), http.StatusInternalServerError)
		return
	}

	for key, values := range r.Header {
		if strings.EqualFold(key, "Origin") || strings.EqualFold(key, "Referer") {
			continue
		}
		for _, value := range values {
			req.Header.Add(key, value)
		}
	}
	if method == "POST" || method == "PUT" {
		req.Header.Set("Content-Type", "application/json")
	}

	client := &http.Client{}
	resp, err := client.Do(req)
	if err != nil {
		http.Error(w, "Bento unreachable: "+err.Error(), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	for key, values := range resp.Header {
		for _, value := range values {
			w.Header().Add(key, value)
		}
	}
	w.Header().Set("Access-Control-Allow-Origin", "*")

	w.WriteHeader(resp.StatusCode)
	io.Copy(w, resp.Body)
}

func handleStatic(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
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
	switch {
	case strings.HasSuffix(path, ".html"):
		return "text/html; charset=utf-8"
	case strings.HasSuffix(path, ".css"):
		return "text/css; charset=utf-8"
	case strings.HasSuffix(path, ".js"):
		return "application/javascript; charset=utf-8"
	case strings.HasSuffix(path, ".json"):
		return "application/json"
	case strings.HasSuffix(path, ".svg"):
		return "image/svg+xml"
	case strings.HasSuffix(path, ".png"):
		return "image/png"
	case strings.HasSuffix(path, ".jpg"), strings.HasSuffix(path, ".jpeg"):
		return "image/jpeg"
	default:
		return "application/octet-stream"
	}
}
