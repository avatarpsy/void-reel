import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import { redirectToAgentHost } from './services/agent-host-redirect';

// The editor is always used with its agent (see agent-host-redirect). A
// top-level load of /image/ bounces to /ai/image, which embeds this app
// alongside the chat. Checked BEFORE mounting so the un-hosted editor never
// flashes and no project load starts that is about to be discarded.
if (!redirectToAgentHost()) {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}
