import { Routes, Route, Navigate } from "react-router-dom";
import { Toaster } from "sonner";
import { useTheme } from "./lib/theme";
import { Protected } from "./components/Protected";
import { Layout } from "./components/Layout";
import { LoginPage } from "./pages/LoginPage";
import { BooksPage } from "./pages/BooksPage";
import { BookPage } from "./pages/BookPage";
import { AllBooksPage } from "./pages/AllBooksPage";
import { BookSettingsPage } from "./pages/BookSettingsPage";
import { LearningPage } from "./pages/LearningPage";
import { ReviewPage } from "./pages/ReviewPage";
import { StatsPage } from "./pages/StatsPage";

export function App() {
  const { resolved } = useTheme();
  return (
    <>
      <Toaster position="bottom-right" richColors closeButton theme={resolved} />
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
          <Route path="/review" element={<ReviewPage />} />
          <Route path="/stats" element={<StatsPage />} />
          {/* Static, so it wins over /books/:id — "all" is never a book id. */}
          <Route path="/books/all" element={<AllBooksPage />} />
          <Route path="/books/:id" element={<BookPage />} />
          <Route path="/books/:id/settings" element={<BookSettingsPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  );
}
