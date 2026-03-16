package main

import (
	"embed"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
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
	http.HandleFunc("/streams", handleStreams)
	http.HandleFunc("/streams/", handleStreams)

	addr := fmt.Sprintf("0.0.0.0:%d", *port)
	log.Printf("BentoViz serving on http://0.0.0.0:%d", *port)
	log.Printf("Proxying to Bento at %s", bentoURL)
	if err := http.ListenAndServe(addr, nil); err != nil {
		log.Fatal(err)
	}
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

func handleStreams(w http.ResponseWriter, r *http.Request) {
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
