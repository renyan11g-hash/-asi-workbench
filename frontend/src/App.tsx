import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { PageTransition } from "@/components/PageTransition";
import { AppLayout } from "@/components/AppLayout";
import Dashboard from "./pages/Dashboard";
import OrderCenter from "./pages/OrderCenter";
import Sourcing from "./pages/Sourcing";
import Batch from "./pages/Batch";
import MasterData from "./pages/MasterData";
import Pipeline from "./pages/Pipeline";
import SourcingSuggest from "./pages/SourcingSuggest";
import Evaluations from "./pages/Evaluations";
import Library from "./pages/Library";
import ListingEditor from "./pages/ListingEditor";
import ListingReviews from "./pages/ListingReviews";
import ProductSpecsPage from "./pages/ProductSpecs";
import Production from "./pages/Production";
import ReviewCenter from "./pages/ReviewCenter";
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
                path="sourcing-suggest"
                data-genie-key="SourcingSuggest"
                data-genie-title="选品预估"
                element={<PageTransition transition="fade"><SourcingSuggest /></PageTransition>}
              />
              <Route
                path="sourcing"
                data-genie-key="Sourcing"
                data-genie-title="产品信息预填"
                element={<PageTransition transition="fade"><Sourcing /></PageTransition>}
              />
              <Route
                path="master-data"
                data-genie-key="MasterData"
                data-genie-title="产品资料库"
                element={<PageTransition transition="fade"><MasterData /></PageTransition>}
              />
              <Route
                path="pipeline"
                data-genie-key="Pipeline"
                data-genie-title="产品流水线"
                element={<PageTransition transition="fade"><Pipeline /></PageTransition>}
              />
              <Route
                path="batch"
                data-genie-key="Batch"
                data-genie-title="批量处理"
                element={<PageTransition transition="fade"><Batch /></PageTransition>}
              />
              <Route
                path="production"
                data-genie-key="Production"
                data-genie-title="批量生产中心"
                element={<PageTransition transition="fade"><Production /></PageTransition>}
              />
              <Route
                path="specs"
                data-genie-key="ProductSpecs"
                data-genie-title="产品资料卡"
                element={<PageTransition transition="fade"><ProductSpecsPage /></PageTransition>}
              />
              <Route
                path="review-center"
                data-genie-key="ReviewCenter"
                data-genie-title="Listing 审核中心"
                element={<PageTransition transition="fade"><ReviewCenter /></PageTransition>}
              />
              <Route
                path="evaluations"
                data-genie-key="Evaluations"
                data-genie-title="评估库"
                element={<PageTransition transition="fade"><Evaluations /></PageTransition>}
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
                path="listing-reviews"
                data-genie-key="ListingReviews"
                data-genie-title="英文链接待审核"
                element={<PageTransition transition="fade"><ListingReviews /></PageTransition>}
              />
              <Route
                path="order-center"
                data-genie-key="OrderCenter"
                data-genie-title="订单运营中心"
                element={<PageTransition transition="fade"><OrderCenter /></PageTransition>}
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
