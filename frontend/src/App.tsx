import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
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
import Production from "./pages/Production";
import RpaArchive from "./pages/RpaArchive";
import SettingsPage from "./pages/SettingsPage";
import NotFound from "./pages/NotFound";

/**
 * Configure TanStack Query client with optimized defaults
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // 数据 15 秒后就当作过期：切回页面/定时轮询时会自动重新拉，不用手动刷新
      staleTime: 15 * 1000,
      // Cache data for 5 minutes
      gcTime: 5 * 60 * 1000,
      // Retry failed requests once
      retry: 1,
      // 切回标签页自动刷新（别的页面改了资料，回来就是最新的）
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
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
                data-genie-title="批次进度"
                element={<PageTransition transition="fade"><Production /></PageTransition>}
              />
              {/* 产品资料卡已并入「产品资料库」，旧地址重定向过去，避免收藏夹失效 */}
              <Route path="specs" element={<Navigate to="/master-data" replace />} />
              {/* Listing 审核中心已并入「listing 待审核中心」 */}
              <Route path="review-center" element={<Navigate to="/listing-reviews" replace />} />
              <Route
                path="rpa"
                data-genie-key="RpaArchive"
                data-genie-title="RPA 档案库"
                element={<PageTransition transition="fade"><RpaArchive /></PageTransition>}
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
