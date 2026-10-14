import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { PageTransition } from "@/components/PageTransition";
import { AppLayout } from "@/components/AppLayout";
import Dashboard from "./pages/Dashboard";
import Sourcing from "./pages/Sourcing";
import Library from "./pages/Library";
import ListingEditor from "./pages/ListingEditor";
import SettingsPage from "./pages/SettingsPage";
import NotFound from "./pages/NotFound";

/**
 * Configure TanStack Query client with optimized defaults
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Data considered fresh for 1 minute
      staleTime: 60 * 1000,
      // Cache data for 5 minutes
      gcTime: 5 * 60 * 1000,
      // Retry failed requests once
      retry: 1,
      // Don't refetch on window focus by default
      refetchOnWindowFocus: false,
      // Don't refetch on reconnect by default
      refetchOnReconnect: false,
    },
    mutations: {
      // Retry failed mutations once
      retry: 1,
    },
  },
});

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster richColors position="top-center" />
        <BrowserRouter>
          <Routes>
            <Route element={<AppLayout />}>
              <Route
                index
                data-genie-key="Dashboard"
                data-genie-title="工作台概览"
                element={<PageTransition transition="fade"><Dashboard /></PageTransition>}
              />
              <Route
                path="sourcing"
                data-genie-key="Sourcing"
                data-genie-title="1688 选品评估"
                element={<PageTransition transition="fade"><Sourcing /></PageTransition>}
              />
              <Route
                path="library"
                data-genie-key="Library"
                data-genie-title="产品库"
                element={<PageTransition transition="fade"><Library /></PageTransition>}
              />
              <Route
                path="listing/:id"
                data-genie-key="Listing"
                data-genie-title="英文链接生成"
                element={<PageTransition transition="fade"><ListingEditor /></PageTransition>}
              />
              <Route
                path="settings"
                data-genie-key="Settings"
                data-genie-title="设置"
                element={<PageTransition transition="fade"><SettingsPage /></PageTransition>}
              />
            </Route>
            <Route path="*" data-genie-key="NotFound" data-genie-title="Not Found" element={<NotFound />} />
          </Routes>
        </BrowserRouter>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App
