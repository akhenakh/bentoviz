# BentoViz

A visual node editor for Bento stream processing workflows, built with LiteGraph.js.

## Overview

BentoViz provides a graphical interface for designing, configuring, and deploying Bento stream processing pipelines. It allows you to:

- Visually compose input → processor → output pipelines
- Auto-generate configuration from the Bento JSON schema
- Deploy streams directly to a running Bento instance
- Save and load workflow graphs
- Export configurations in YAML or JSON format

## Features

- **Visual Node Editor**: Drag-and-drop interface for building stream pipelines
- **Schema-Driven**: Automatically generates nodes from Bento's JSON schema (inputs, processors, outputs)
- **Live Deployment**: Deploy streams to Bento via REST API
- **YAML Export**: Generate clean YAML configurations
- **Auto-Save**: Graphs are automatically saved to browser storage
- **Stream Management**: List, deploy, and stop streams from the UI

## Prerequisites

- [Go 1.21+](https://golang.org/dl/)
- A running [Bento](https://github.com/warpstreamlabs/bento) instance (for stream deployment)

## Building

```bash
# Clone the repository
git clone https://github.com/yourorg/bentoviz.git
cd bentoviz

# Build the binary
go build -o bentoviz .
```

## Running

```bash
# Start BentoViz (default: port 8080, proxies to localhost:4195)
./bentoviz

# Custom port and Bento URL
./bentoviz -port 3000 -bento http://localhost:4195

# Show help
./bentoviz -h
```

You need a running Bento: `bento streams`.

## Usage

1. **Open the Editor**: Navigate to `http://localhost:8080` in your browser

2. **Add Nodes**: 
   - Double-click or drag nodes from the left palette into the canvas
   - Nodes are organized by category: Inputs, Processors, Outputs

3. **Connect Nodes**:
   - Drag from an output port to an input port to create connections
   - Pipeline flow: Input → Processor(s) → Output

4. **Configure Nodes**:
   - Click on a node to see its properties
   - Click on text fields to edit values
   - For multiline fields (mapping, bloblang), a popup dialog appears

5. **Deploy Stream**:
   - Enter a Stream ID in the sidebar
   - Click "Deploy Stream" to push to Bento
   - View active streams in the Streams list

6. **Export Configuration**:
   - Click "Preview Config" to see the generated YAML
   - Click the copy button to copy to clipboard

7. **Save/Load Graphs**:
   - "Save" button downloads the current graph as JSON
   - "Load" button imports a previously saved graph


## Development

### Modifying the Frontend

The frontend uses ES modules loaded directly from CDN:
- **LiteGraph.js** - Canvas-based node graph editor
- No bundler required - just edit `app.js` and `styles.css`

### Updating the Schema

1. Download the latest Bento schema:
   ```bash
   # From Bento's docs or source
   curl -o schema.json https://raw.githubusercontent.com/warpstreamlabs/bento/main/config/schema.json
   ```

2. Rebuild the binary:
   ```bash
   go build -o bentoviz .
   ```

### Adding New Node Types

Nodes are automatically generated from `schema.json`. The schema structure:
- `properties.input.*` → Input nodes
- `properties.pipeline.properties.processors.items.properties.*` → Processor nodes
- `properties.output.*` → Output nodes

## API Endpoints

The Go server proxies the following endpoints to Bento:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/streams` | GET | List all streams |
| `/streams/{id}` | POST | Create/update stream |
| `/streams/{id}` | DELETE | Delete stream |

## License

MIT License - see LICENSE file for details.
