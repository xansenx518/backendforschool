import express from 'express'
import pg from 'pg'
import cors from 'cors'
import dotenv from 'dotenv'

dotenv.config()

const app = express()
const PORT = process.env.PORT || 4000

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL || `postgresql://${process.env.DB_USER}:${process.env.DB_PASSWORD}@${process.env.DB_HOST}:${process.env.DB_PORT || 5432}/${process.env.DB_NAME}`,
})

const ADMIN_USER = process.env.ADMIN_USER || 'admin'
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123'
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'admin-secret-token'

const ALLOWED_ORIGINS = (process.env.FRONTEND_ORIGINS || 'http://localhost:5174,https://marinasschoolsupply.vercel.app').split(',')

app.use(cors({ origin: ALLOWED_ORIGINS, credentials: true }))
app.use(express.json())

const parseCookies = (cookieHeader = '') =>
  cookieHeader.split(';').reduce((cookies, pair) => {
    const [key, ...rest] = pair.trim().split('=')
    if (!key) return cookies
    cookies[key] = decodeURIComponent(rest.join('='))
    return cookies
  }, {})

const requireAdminAuth = (req, res, next) => {
  const authHeader = req.headers.authorization || ''
  const headerToken = authHeader.replace(/^Bearer\s+/i, '')
  const cookieToken = parseCookies(req.headers.cookie).adminToken
  const token = headerToken || cookieToken

  if (!token || token !== ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  next()
}

const ensureAdminUserTable = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_users (
      username TEXT PRIMARY KEY,
      password TEXT NOT NULL,
      token TEXT NOT NULL
    )
  `)

  const existing = await pool.query(
    'SELECT username FROM admin_users WHERE username = $1',
    [ADMIN_USER]
  )

  if (existing.rowCount === 0) {
    await pool.query(
      'INSERT INTO admin_users (username, password, token) VALUES ($1, $2, $3)',
      [ADMIN_USER, ADMIN_PASS, ADMIN_TOKEN]
    )
  }
}

app.post('/api/admin/login', async (req, res) => {
  const { username, password } = req.body

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' })
  }

  try {
    const result = await pool.query(
      'SELECT username, password, token FROM admin_users WHERE username = $1',
      [username]
    )

    if (result.rowCount === 1 && result.rows[0].password === password) {
      const token = result.rows[0].token
      const cookieValue = `adminToken=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Strict${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`
      res.setHeader('Set-Cookie', cookieValue)
      return res.json({ success: true })
    }
  } catch (error) {
    console.error('Admin login DB error:', error)
  }

  if (username === ADMIN_USER && password === ADMIN_PASS) {
    const cookieValue = `adminToken=${encodeURIComponent(ADMIN_TOKEN)}; HttpOnly; Path=/; SameSite=Strict${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`
    res.setHeader('Set-Cookie', cookieValue)
    return res.json({ success: true })
  }

  return res.status(401).json({ error: 'Invalid username or password' })
})

app.get('/api/products', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, productname AS "productName", price, productimage AS "productImage" FROM products'
    )
    res.json(result.rows)
  } catch (error) {
    console.error('Database error:', error)
    // Fallback to mock data when database is unavailable
    const mockProducts = [
      { id: 1, productName: 'Pencil', price: 10.00, productImage: '/images/products/pencil.svg' },
      { id: 2, productName: 'Notebook', price: 30.00, productImage: '/images/products/notebook.svg' },
      { id: 3, productName: 'Bond Paper', price: 3.00, productImage: '/images/products/paper.svg' },
    ]
    res.json(mockProducts)
  }
})

app.post('/api/checkout', async (req, res) => {
  const { cartItems, customer } = req.body
  if (!cartItems || Object.keys(cartItems).length === 0) {
    return res.status(400).json({ error: 'Cart is empty.' })
  }

  if (!customer || !customer.name || !customer.address || !customer.contactNumber) {
    return res.status(400).json({ error: 'Customer information is required.' })
  }

  const productIds = Object.keys(cartItems).map((id) => Number(id))
  const client = await pool.connect()
  
  try {
    const productsResult = await client.query(
      'SELECT id, price FROM products WHERE id = ANY($1)',
      [productIds]
    )
    const rows = productsResult.rows

    if (rows.length !== productIds.length) {
      return res.status(400).json({ error: 'Some cart items are invalid.' })
    }

    const totalAmount = rows.reduce(
      (sum, product) => sum + product.price * (cartItems[product.id] || 0),
      0
    )

    try {
      await client.query('BEGIN')

      const orderResult = await client.query(
        'INSERT INTO orders (total_amount, status, customer_name, customer_address, customer_contact, created_at) VALUES ($1, $2, $3, $4, $5, NOW()) RETURNING id',
        [totalAmount, 'pending', customer.name, customer.address, customer.contactNumber]
      )

      const orderId = orderResult.rows[0].id

      // Generate a human-friendly reference for the order and persist it
      const datePart = new Date().toISOString().slice(0,10).replace(/-/g,'')
      const reference = `MS-${datePart}-${orderId}`
      await client.query('UPDATE orders SET reference = $1 WHERE id = $2', [reference, orderId])
      
      const orderItems = rows.map((product) => [
        orderId,
        product.id,
        cartItems[product.id],
        product.price,
      ])

      if (orderItems.length > 0) {
        const placeholders = orderItems
          .map((_, idx) => `($${idx * 4 + 1}, $${idx * 4 + 2}, $${idx * 4 + 3}, $${idx * 4 + 4})`)
          .join(',')
        const flatValues = orderItems.flat()
        await client.query(
          `INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES ${placeholders}`,
          flatValues
        )
      }

      await client.query('COMMIT')
      res.json({ success: true, orderId, reference, totalAmount })
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  } catch (error) {
    console.error('Checkout error:', error)
    // Fallback to mock checkout when database is unavailable
    const mockProducts = [
      { id: 1, price: 10.00 },
      { id: 2, price: 30.00 },
      { id: 3, price: 3.00 },
    ]

    const totalAmount = mockProducts.reduce(
      (sum, product) => sum + product.price * (cartItems[product.id] || 0),
      0
    )

    const mockOrderId = Math.floor(Math.random() * 100000) + 1000
    console.log(
      `[Mock Order] Order #${mockOrderId} for ${customer.name} - Total: P ${totalAmount.toFixed(2)}`
    )
    const datePart = new Date().toISOString().slice(0,10).replace(/-/g,'')
    const reference = `MS-${datePart}-${mockOrderId}`
    res.json({ success: true, orderId: mockOrderId, reference, totalAmount })
  }
})

app.post('/api/admin/logout', (req, res) => {
  const cookieValue = `adminToken=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`
  res.setHeader('Set-Cookie', cookieValue)
  res.json({ success: true })
})

app.get('/api/admin/session', (req, res) => {
  const cookieToken = parseCookies(req.headers.cookie).adminToken
  if (cookieToken === ADMIN_TOKEN) {
    return res.json({ success: true })
  }
  return res.status(401).json({ error: 'Not authenticated' })
})

app.get('/api/admin/orders', requireAdminAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
        o.id AS orderId,
        o.reference,
        o.customer_name AS customerName,
        o.customer_address AS customerAddress,
        o.customer_contact AS customerContact,
        o.status,
        o.total_amount AS totalAmount,
        o.created_at AS createdAt,
        oi.product_id AS productId,
        oi.quantity,
        oi.unit_price AS unitPrice,
        p.productName AS productName
      FROM orders o
      LEFT JOIN order_items oi ON oi.order_id = o.id
      LEFT JOIN products p ON p.id = oi.product_id
      ORDER BY o.created_at DESC, o.id DESC`
    )

    const ordersMap = {}
    for (const row of result.rows) {
      if (!ordersMap[row.orderid]) {
        ordersMap[row.orderid] = {
          orderId: row.orderid,
          reference: row.reference,
          customerName: row.customername,
          customerAddress: row.customeraddress,
          customerContact: row.customercontact,
          status: row.status,
          totalAmount: Number(row.totalamount || 0),
          createdAt: row.createdat,
          items: [],
        }
      }
      if (row.productid) {
        ordersMap[row.orderid].items.push({
          productId: row.productid,
          productName: row.productname,
          quantity: row.quantity,
          unitPrice: Number(row.unitprice || 0),
        })
      }
    }

    res.json(Object.values(ordersMap))
  } catch (error) {
    console.error('Orders error:', error)

    const mockOrders = [
      {
        orderId: 1001,
        reference: 'MS-20260610-1001',
        customerName: 'Test Admin',
        customerAddress: '123 Sample St',
        customerContact: '09170000000',
        status: 'pending',
        totalAmount: 40.0,
        createdAt: new Date().toISOString(),
        items: [
          { productId: 1, productName: 'Pencil', quantity: 2, unitPrice: 10.0 },
          { productId: 2, productName: 'Notebook', quantity: 1, unitPrice: 20.0 },
        ],
      },
    ]
    res.json(mockOrders)
  }
})

app.patch('/api/admin/orders/:orderId/status', requireAdminAuth, async (req, res) => {
  const orderId = Number(req.params.orderId)
  const { status } = req.body
  const validStatuses = ['pending', 'delivered', 'cancelled']

  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: 'Invalid status value.' })
  }

  try {
    const result = await pool.query(
      'UPDATE orders SET status = $1 WHERE id = $2',
      [status, orderId]
    )

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Order not found.' })
    }

    res.json({ success: true, orderId, status })
  } catch (error) {
    console.error('Update status error:', error)
    res.status(500).json({ error: 'Unable to update order status.' })
  }
})

const startServer = async () => {
  try {
    await ensureAdminUserTable()
  } catch (error) {
    console.error('Error initializing admin auth table:', error)
  }

  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`)
  })
}

startServer()
