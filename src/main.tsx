import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { ensureMeta } from './db/db';
import { applyTheme, readCachedTheme } from './ui/useTheme';
import './index.css';

// Apply the cached theme before first paint so there is no light-mode flash
// while IndexedDB opens.
applyTheme(readCachedTheme());

// Make sure the singleton meta row exists before anything reads it.
void ensureMeta();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
