import { Routes, Route, Navigate } from "react-router-dom";
import { Toaster } from "sonner";
import { Protected } from "./components/Protected";
import { Layout } from "./components/Layout";
import { LoginPage } from "./pages/LoginPage";
import { BooksPage } from "./pages/BooksPage";
import { BookPage } from "./pages/BookPage";
import { BookSettingsPage } from "./pages/BookSettingsPage";
import { LearningPage } from "./pages/LearningPage";
import { StatsPage } from "./pages/StatsPage";

export function App() {
  return (
    <>
      <Toaster position="bottom-right" richColors closeButton />
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route
          element={
            <Protected>
              <Layout />
            </Protected>
          }
        >
          <Route path="/" element={<BooksPage />} />
          <Route path="/learning" element={<LearningPage />} />
          <Route path="/stats" element={<StatsPage />} />
          <Route path="/books/:id" element={<BookPage />} />
          <Route path="/books/:id/settings" element={<BookSettingsPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  );
}
