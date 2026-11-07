import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { Product } from '@/types'

export function useSettings() {
  return useQuery({ queryKey: ['settings'], queryFn: api.getSettings, staleTime: 30_000 })
}

export function useProducts(params?: { status?: string; q?: string }) {
  return useQuery({
    queryKey: ['products', params?.status ?? '', params?.q ?? ''],
    queryFn: () => api.listProducts(params),
    // 自动刷新：别的页面改完资料/状态，回到这一页不用手动点
    refetchInterval: 30_000,
  })
}

export function useProduct(id?: string) {
  return useQuery({
    queryKey: ['product', id],
    queryFn: () => api.getProduct(id as string),
    enabled: Boolean(id),
  })
}

export function useInvalidateProducts() {
  const qc = useQueryClient()
  return () => {
    qc.invalidateQueries({ queryKey: ['products'] })
    qc.invalidateQueries({ queryKey: ['product'] })
  }
}

export function useSaveProduct() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (payload: Parameters<typeof api.updateProduct>) =>
      api.updateProduct(payload[0], payload[1]),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['products'] })
      qc.invalidateQueries({ queryKey: ['product'] })
    },
  })
}

export function productScore(p: Product): number {
  return p.evaluation?.score ?? 0
}
