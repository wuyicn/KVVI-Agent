/**
 * Standalone demo entry for dsh-node-flow.
 * In the DSH client this same Canvas component is mounted by the plugin;
 * here it runs standalone via Vite for development and screenshots.
 *
 * @module ui/main
 */

import { createRoot } from 'react-dom/client'
import '@xyflow/react/dist/style.css'
import '../components/canvas.css'
import '../components/editor.css'
import '../components/app.css'
import { Overlay } from '../components/Overlay.js'

const rootEl = document.getElementById('root')
if (rootEl) {
  createRoot(rootEl).render(<Overlay onClose={() => {}} />)
}
