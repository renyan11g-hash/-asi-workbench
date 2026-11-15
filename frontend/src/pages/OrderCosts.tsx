import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { orderApi, businessOpsApi } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'

export default function OrderCosts() {
  const qc=useQueryClient()
  const orders=useQuery({queryKey:['orders-cost-entry'],queryFn:()=>orderApi.listOrders()})
  const [orderId,setOrderId]=useState('')
  const [productCostCny,setProductCostCny]=useState('0')
  const [customizationCostCny,setCustomizationCostCny]=useState('0')
  const [domesticShippingCny,setDomesticShippingCny]=useState('0')
  const [internationalShippingUsd,setInternationalShippingUsd]=useState('0')
  const [otherCostUsd,setOtherCostUsd]=useState('0')
  const [exchangeRate,setExchangeRate]=useState('7.2')
  const [commissionRate,setCommissionRate]=useState('0.4')
  const [note,setNote]=useState('')
  const current=useQuery({queryKey:['order-financials',orderId],queryFn:()=>businessOpsApi.getOrderFinancials(orderId),enabled:Boolean(orderId)})
  const save=useMutation({
    mutationFn:()=>businessOpsApi.saveOrderFinancials(orderId,{
      productCostCny:Number(productCostCny),customizationCostCny:Number(customizationCostCny),domesticShippingCny:Number(domesticShippingCny),
      internationalShippingUsd:Number(internationalShippingUsd),otherCostUsd:Number(otherCostUsd),exchangeRate:Number(exchangeRate),commissionRate:Number(commissionRate),note
    }),
    onSuccess:()=>{qc.invalidateQueries({queryKey:['business-ops-performance']});qc.invalidateQueries({queryKey:['business-ops-overview']});toast.success('订单成本已保存')}
  })
  const load=async(id:string)=>{
    setOrderId(id)
    if(!id)return
    const result:any=await businessOpsApi.getOrderFinancials(id)
    const f=result.financials
    if(f){setProductCostCny(String(f.product_cost_cny));setCustomizationCostCny(String(f.customization_cost_cny));setDomesticShippingCny(String(f.domestic_shipping_cny));setInternationalShippingUsd(String(f.international_shipping_usd));setOtherCostUsd(String(f.other_cost_usd));setExchangeRate(String(f.exchange_rate));setCommissionRate(String(f.commission_rate));setNote(f.note??'')}
    else{setProductCostCny('0');setCustomizationCostCny('0');setDomesticShippingCny('0');setInternationalShippingUsd('0');setOtherCostUsd('0');setExchangeRate('7.2');setCommissionRate('0.4');setNote('')}
  }
  const fields=[
    ['采购成本（CNY）',productCostCny,setProductCostCny],['印刷/定制成本（CNY）',customizationCostCny,setCustomizationCostCny],
    ['国内运费（CNY）',domesticShippingCny,setDomesticShippingCny],['国际运费（USD）',internationalShippingUsd,setInternationalShippingUsd],
    ['其他直接成本（USD）',otherCostUsd,setOtherCostUsd],['汇率（CNY/USD）',exchangeRate,setExchangeRate],['提成比例（0-1）',commissionRate,setCommissionRate]
  ] as const
  const order=(orders.data??[]).find(o=>o.id===orderId)
  return <div className="mx-auto max-w-4xl space-y-5">
    <div><h2 className="text-lg font-semibold">订单成本与提成核算</h2><p className="mt-1 text-sm text-slate-500">人民币成本按录入汇率换算成美元；未填写完整成本的订单不计入利润合计。提成比例默认为 40%，请按公司实际规则核对。</p></div>
    <div className="rounded-xl border bg-white p-5">
      <Label htmlFor="cost-order">选择订单</Label>
      <select id="cost-order" className="mt-2 h-10 w-full rounded-md border bg-white px-3 text-sm" value={orderId} onChange={e=>load(e.target.value)}>
        <option value="">请选择订单</option>{(orders.data??[]).map(o=><option key={o.id} value={o.id}>{o.orderNumber} · USD {o.totalAmount.toFixed(2)}</option>)}
      </select>
      {order&&<p className="mt-2 text-xs text-slate-500">订单金额：USD {order.totalAmount.toFixed(2)} · 状态：{order.status} · 收款：{order.paymentStatus}</p>}
    </div>
    {orderId&&<div className="rounded-xl border bg-white p-5">
      <div className="grid gap-4 sm:grid-cols-2">
        {fields.map(([label,value,set])=><div key={label}><Label>{label}</Label><Input className="mt-1" type="number" min="0" step="0.01" value={value} onChange={e=>set(e.target.value)}/></div>)}
      </div>
      <div className="mt-4"><Label>成本备注</Label><Textarea className="mt-1" rows={3} value={note} onChange={e=>setNote(e.target.value)} placeholder="记录报价来源、运费口径、尚未结算的费用等"/></div>
      <Button className="mt-4" onClick={()=>save.mutate()} disabled={save.isPending}>保存成本</Button>
      <p className="mt-3 text-xs text-slate-500">注意：当前版本将每类成本作为订单级汇总录入，不会自动从旧产品价格推算实际采购成本，也不会修改历史订单金额。</p>
    </div>}
  </div>
}
