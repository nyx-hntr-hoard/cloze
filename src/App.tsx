import { createHashRouter, RouterProvider } from 'react-router-dom';
import { Layout } from './routes/Layout';
import { DeckList } from './routes/DeckList';
import { DeckDetail } from './routes/DeckDetail';
import { AddNotes } from './routes/AddNotes';
import { CsvImport } from './routes/CsvImport';
import { EditNote } from './routes/EditNote';
import { Review } from './routes/Review';
import { Backup } from './routes/Backup';
import { Browse } from './routes/Browse';
import { Stats } from './routes/Stats';
import { Settings } from './routes/Settings';
import './App.css';

/**
 * Hash routing rather than browser history: the built app is a folder of static
 * files meant to be opened from disk or dropped on any static host, with no
 * server to rewrite deep links back to index.html.
 */
const router = createHashRouter([
  {
    path: '/',
    element: <Layout />,
    children: [
      { index: true, element: <DeckList /> },
      { path: 'deck/:deckId', element: <DeckDetail /> },
      { path: 'deck/:deckId/add', element: <AddNotes /> },
      { path: 'deck/:deckId/import-csv', element: <CsvImport /> },
      { path: 'deck/:deckId/review', element: <Review /> },
      { path: 'deck/:deckId/note/:noteId', element: <EditNote /> },
      { path: 'browse', element: <Browse /> },
      { path: 'stats', element: <Stats /> },
      { path: 'backup', element: <Backup /> },
      { path: 'settings', element: <Settings /> },
      {
        path: '*',
        element: (
          <div className="empty">
            <h2>Page not found</h2>
            <p>
              <a href="#/">Back to decks</a>
            </p>
          </div>
        ),
      },
    ],
  },
]);

export default function App() {
  return <RouterProvider router={router} />;
}
