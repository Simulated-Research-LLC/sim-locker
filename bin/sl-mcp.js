#!/usr/bin/env node
// sl-mcp: the Sim Locker MCP server over stdio. Run it with the project folder as the working directory, or pass it as the first argument.
import { serve } from "../src/mcp.js";
serve(process.argv[2] ?? process.cwd()).catch((e) => { process.stderr.write(`sim-locker mcp: ${e.message}\n`); process.exit(1); });
