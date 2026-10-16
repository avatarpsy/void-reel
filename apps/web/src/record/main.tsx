import ReactDOM from "react-dom/client";
import "../index.css";
import { ShotRecorder } from "./ShotRecorder";

/**
 * Entry for /studio/record.html — the board's one-shot recorder. Deliberately
 * NOT the editor: no App, no project stores, no Firebase. It shares the
 * recorder, preview and teleprompter modules with the editor, nothing else.
 *
 * No StrictMode: its double-run of effects in development would open the
 * camera twice on every load.
 */
ReactDOM.createRoot(document.getElementById("root")!).render(<ShotRecorder />);
