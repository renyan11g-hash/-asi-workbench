import { Router, Request, Response } from 'express'
import { db } from '../db'

export const dashboardRouter: Router = Router()

// ---------- Dashboard 概览统计 ----------
dashboardRouter.get('/overview', async (_req: Request, res: Response) => {
  // 客户总数
  const customerCount = db.prepare('SELECT COUNT(*) as c FROM customers').get() as { c: number }

  // 询盘统计
  const inquiryTotal = db.prepare('SELECT COUNT(*) as c FROM inquiries').get() as { c: number }
  const inquiryNew = db.prepare("SELECT COUNT(*) as c FROM inquiries WHERE status = 'new'").get() as { c: number }
  const inquiryResponded = db.prepare("SELECT COUNT(*) as c FROM inquiries WHERE status = 'responded'").get() as { c: number }
  const inquiryConverted = db.prepare("SELECT COUNT(*) as c FROM inquiries WHERE status = 'converted'").get() as { c: number }

  // 订单统计
  const orderTotal = db.prepare('SELECT COUNT(*) as c FROM orders').get() as { c: number }
  const orderPending = db.prepare("SELECT COUNT(*) as c FROM orders WHERE status = 'pending'").get() as { c: number }
  const orderConfirmed = db.prepare("SELECT COUNT(*) as c FROM orders WHERE status = 'confirmed'").get() as { c: number }
  const orderProduction = db.prepare("SELECT COUNT(*) as c FROM orders WHERE status = 'production'").get() as { c: number }
  const orderShipped = db.prepare("SELECT COUNT(*) as c FROM orders WHERE status = 'shipped'").get() as { c: number }

  // 订单金额统计
  const orderRevenue = db.prepare('SELECT SUM(total_amount) as s FROM orders').get() as { s: number | null }
  const totalRevenue = orderRevenue.s || 0

  // 待收款订单
  const unpaidOrders = db.prepare("SELECT COUNT(*) as c FROM orders WHERE payment_status = 'unpaid'").get() as { c: number }

  // 产品总数
  const productCount = db.prepare("SELECT COUNT(*) as c FROM products WHERE status != 'trashed'").get() as { c: number }

  res.json({
    customers: {
      total: customerCount.c,
    },
    inquiries: {
      total: inquiryTotal.c,
      new: inquiryNew.c,
      responded: inquiryResponded.c,
      converted: inquiryConverted.c,
    },
    orders: {
      total: orderTotal.c,
      pending: orderPending.c,
      confirmed: orderConfirmed.c,
      production: orderProduction.c,
      shipped: orderShipped.c,
      unpaid: unpaidOrders.c,
      totalRevenue,
    },
    products: {
      total: productCount.c,
    },
  })
})

// ---------- 询盘趋势（最近30天） ----------
dashboardRouter.get('/inquiries/trend', async (_req: Request, res: Response) => {
  const thirtyDaysAgo = new Date()
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)

  const rows = db
    .prepare(
      `SELECT
        DATE(created_at) as date,
        COUNT(*) as count
       FROM inquiries
       WHERE created_at >= ?
       GROUP BY DATE(created_at)
       ORDER BY date ASC`
    )
    .all(thirtyDaysAgo.toISOString()) as Array<{ date: string; count: number }>

  res.json({ trend: rows })
})

// ---------- 订单趋势（最近30天） ----------
dashboardRouter.get('/orders/trend', async (_req: Request, res: Response) => {
  const thirtyDaysAgo = new Date()
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)

  const rows = db
    .prepare(
      `SELECT
        DATE(created_at) as date,
        COUNT(*) as count,
        SUM(total_amount) as revenue
       FROM orders
       WHERE created_at >= ?
       GROUP BY DATE(created_at)
       ORDER BY date ASC`
    )
    .all(thirtyDaysAgo.toISOString()) as Array<{ date: string; count: number; revenue: number | null }>

  res.json({
    trend: rows.map((r) => ({
      date: r.date,
      count: r.count,
      revenue: r.revenue || 0,
    })),
  })
})

// ---------- 利润分析 ----------
dashboardRouter.get('/profit-analysis', async (_req: Request, res: Response) => {
  // 获取所有已完成的订单
  const orders = db
    .prepare(
      `SELECT
        o.id,
        o.order_number,
        o.total_amount,
        o.created_at,
        c.name as customer_name
       FROM orders o
       JOIN customers c ON o.customer_id = c.id
       WHERE o.status IN ('shipped', 'delivered')
       ORDER BY o.created_at DESC
       LIMIT 100`
    )
    .all() as Array<{
      id: string
      order_number: string
      total_amount: number
      created_at: string
      customer_name: string
    }>

  // 计算每个订单的利润（基于产品成本）
  const profitData: Array<{
    orderNumber: string
    customerName: string
    revenue: number
    cost: number
    profit: number
    margin: number
    createdAt: string
  }> = []
  for (const order of orders) {
    const items = db
      .prepare(
        `SELECT
          oi.quantity,
          oi.unit_price,
          p.price_cny
         FROM order_items oi
         JOIN products p ON oi.product_id = p.id
         WHERE oi.order_id = ?`
      )
      .all(order.id) as Array<{
      quantity: number
      unit_price: number
      price_cny: number | null
    }>

    let totalCost = 0
    let totalRevenue = 0

    for (const item of items) {
      const revenue = item.quantity * item.unit_price
      totalRevenue += revenue

      // 简化的成本计算（仅产品成本，未包含运费、印刷等）
      const cost = item.price_cny ? item.quantity * item.price_cny : 0
      totalCost += cost
    }

    profitData.push({
      orderNumber: order.order_number,
      customerName: order.customer_name,
      revenue: totalRevenue,
      cost: totalCost,
      profit: totalRevenue - totalCost,
      margin: totalRevenue > 0 ? ((totalRevenue - totalCost) / totalRevenue) * 100 : 0,
      createdAt: order.created_at,
    })
  }

  // 汇总统计
  const totalRevenue = profitData.reduce((sum, p) => sum + p.revenue, 0)
  const totalCost = profitData.reduce((sum, p) => sum + p.cost, 0)
  const totalProfit = totalRevenue - totalCost
  const avgMargin = profitData.length > 0 ? profitData.reduce((sum, p) => sum + p.margin, 0) / profitData.length : 0

  res.json({
    summary: {
      totalRevenue,
      totalCost,
      totalProfit,
      avgMargin,
      orderCount: profitData.length,
    },
    details: profitData,
  })
})

// ---------- 热门产品（按订单次数） ----------
dashboardRouter.get('/products/popular', async (_req: Request, res: Response) => {
  const rows = db
    .prepare(
      `SELECT
        p.id,
        p.source_title,
        COUNT(oi.id) as order_count,
        SUM(oi.quantity) as total_quantity,
        SUM(oi.total_price) as total_revenue
       FROM products p
       JOIN order_items oi ON p.id = oi.product_id
       WHERE p.status != 'trashed'
       GROUP BY p.id
       ORDER BY order_count DESC
       LIMIT 20`
    )
    .all() as Array<{
      id: string
      source_title: string
      order_count: number
      total_quantity: number
      total_revenue: number | null
    }>

  res.json({
    popularProducts: rows.map((r) => ({
      productId: r.id,
      productName: r.source_title,
      orderCount: r.order_count,
      totalQuantity: r.total_quantity,
      totalRevenue: r.total_revenue || 0,
    })),
  })
})

// ---------- 供应商沟通统计 ----------
dashboardRouter.get('/supplier-communications/stats', async (_req: Request, res: Response) => {
  const totalComms = db.prepare('SELECT COUNT(*) as c FROM supplier_communications').get() as { c: number }

  const commsWithPrice = db.prepare("SELECT COUNT(*) as c FROM supplier_communications WHERE price_cny IS NOT NULL").get() as { c: number }

  const uniqueSuppliers = db.prepare('SELECT COUNT(DISTINCT supplier_name) as c FROM supplier_communications').get() as { c: number }

  // 最近7天的沟通次数
  const sevenDaysAgo = new Date()
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7)

  const recentComms = db
    .prepare('SELECT COUNT(*) as c FROM supplier_communications WHERE created_at >= ?')
    .get(sevenDaysAgo.toISOString()) as { c: number }

  res.json({
    totalCommunications: totalComms.c,
    communicationsWithPrice: commsWithPrice.c,
    uniqueSuppliers: uniqueSuppliers.c,
    recentCommunications: recentComms.c,
  })
})

// ---------- 待处理事项 ----------
dashboardRouter.get('/pending-tasks', async (_req: Request, res: Response) => {
  // 新询盘
  const newInquiries = db
    .prepare(
      `SELECT
        i.id,
        i.subject,
        c.name as customer_name,
        i.created_at
       FROM inquiries i
       JOIN customers c ON i.customer_id = c.id
       WHERE i.status = 'new'
       ORDER BY i.created_at DESC
       LIMIT 10`
    )
    .all() as Array<{
      id: string
      subject: string
      customer_name: string
      created_at: string
    }>

  // 待确认订单
  const pendingOrders = db
    .prepare(
      `SELECT
        o.id,
        o.order_number,
        c.name as customer_name,
        o.total_amount,
        o.created_at
       FROM orders o
       JOIN customers c ON o.customer_id = c.id
       WHERE o.status = 'pending'
       ORDER BY o.created_at DESC
       LIMIT 10`
    )
    .all() as Array<{
      id: string
      order_number: string
      customer_name: string
      total_amount: number
      created_at: string
    }>

  // 待收款订单
  const unpaidOrders = db
    .prepare(
      `SELECT
        o.id,
        o.order_number,
        c.name as customer_name,
        o.total_amount,
        o.deposit_amount,
        o.balance_amount,
        o.created_at
       FROM orders o
       JOIN customers c ON o.customer_id = c.id
       WHERE o.payment_status = 'unpaid'
       ORDER BY o.created_at DESC
       LIMIT 10`
    )
    .all() as Array<{
      id: string
      order_number: string
      customer_name: string
      total_amount: number
      deposit_amount: number | null
      balance_amount: number | null
      created_at: string
    }>

  res.json({
    newInquiries: newInquiries.map((i) => ({
      inquiryId: i.id,
      subject: i.subject,
      customerName: i.customer_name,
      createdAt: i.created_at,
    })),
    pendingOrders: pendingOrders.map((o) => ({
      orderId: o.id,
      orderNumber: o.order_number,
      customerName: o.customer_name,
      totalAmount: o.total_amount,
      createdAt: o.created_at,
    })),
    unpaidOrders: unpaidOrders.map((o) => ({
      orderId: o.id,
      orderNumber: o.order_number,
      customerName: o.customer_name,
      totalAmount: o.total_amount,
      depositAmount: o.deposit_amount,
      balanceAmount: o.balance_amount,
      createdAt: o.created_at,
    })),
  })
})
