import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import { redirectToAgentHost } from './services/agent-host-redirect';
import { setBlockTokenProvider } from '@openreel/asset-browser';
import { getVoidspaceIdToken } from './services/voidspace-storage';

/**
 * Tell the shared block machinery how THIS app gets a token.
 *
 * Reading a block — for a live preview tile, or to render a composition layer —
 * is an authenticated call, and the three surfaces that make it hold their
 * credentials in three different places. The package states what it needs and
 * each app answers; see its `auth.ts`. Set before React mounts, so the first
 * tile to become visible already has one.
 */
setBlockTokenProvider(getVoidspaceIdToken);

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
