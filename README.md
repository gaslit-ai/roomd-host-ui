# roomd-host-ui

MCP Apps host UI for Roomd, built with Next.js, assistant-ui, and the MCP TypeScript SDK.

## Getting started

Create `.env.local` with an OpenAI API key and the Roomd MCP endpoint:

```bash
OPENAI_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
MCP_SERVER_URL=http://localhost:8090/rooms/example/mcp
```

Then install dependencies and run the development server:

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.
