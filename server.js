require('dotenv').config();
const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const path = require('path');
const { pool, initSchema } = require('./db');

const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const catalogRoutes = require('./routes/catalog');
const sourcingRoutes = require('./routes/sourcing');
const processingRoutes = require('./routes/processing');
const qualityRoutes = require('./routes/quality');
const dispatchRoutes = require('./routes/dispatch');
const batchRoutes = require('./routes/batches');
const traceRoutes = require('./routes/trace');
const supplierRoutes = require('./routes/suppliers');
const packingRoutes = require('./routes/packing');
const rolesRoutes = require('./routes/roles');
const masterDataRoutes = require('./routes/masterData');
const customerRoutes = require('./routes/customers');
const productVariantRoutes = require('./routes/productVariants');
const pricingControlsRoutes = require('./routes/pricingControls');
const approvalsRoutes = require('./routes/approvals');
const quotationRoutes = require('./routes/quotations');
const customerPORoutes = require('./routes/customerPOs');
const salesOrderAmendmentRoutes = require('./routes/salesOrderAmendments');
const documentRoutes = require('./routes/documents');
const notificationRoutes = require('./routes/notifications');
const timelineRoutes = require('./routes/timeline');
const salesOrderRoutes = require('./routes/salesOrders');
const searchRoutes = require('./routes/search');
const dispatchCustomerRoutes = require('./routes/dispatchCustomers');
const uridPreprocessingRoutes = require('./routes/uridPreprocessing');
const uridDhallRoutes = require('./routes/uridDhallProcessing');

const app = express();
app.set('trust proxy', 1); // needed behind Railway/Render/any reverse proxy for secure cookies

app.use(express.json());

app.use(session({
  store: new pgSession({ pool, tableName: 'session' }),
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 * 12, // 12 hour session
  },
}));

app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api', catalogRoutes);
app.use('/api', sourcingRoutes);
app.use('/api', processingRoutes);
app.use('/api', qualityRoutes);
app.use('/api', dispatchRoutes);
app.use('/api', batchRoutes);
app.use('/api', traceRoutes);
app.use('/api', supplierRoutes);
app.use('/api', packingRoutes);
app.use('/api', rolesRoutes);
app.use('/api', masterDataRoutes);
app.use('/api', customerRoutes);
app.use('/api', productVariantRoutes);
app.use('/api', pricingControlsRoutes);
app.use('/api', approvalsRoutes);
app.use('/api', quotationRoutes);
app.use('/api', customerPORoutes);
app.use('/api', salesOrderAmendmentRoutes);
app.use('/api', documentRoutes);
app.use('/api', notificationRoutes);
app.use('/api', timelineRoutes);
app.use('/api', salesOrderRoutes);
app.use('/api', searchRoutes);
app.use('/api', dispatchCustomerRoutes);
app.use('/api', uridPreprocessingRoutes);
app.use('/api', uridDhallRoutes);

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// basic error handler so a bug returns JSON instead of crashing the process
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server.' });
});

// CRITICAL SAFETY NET: an unhandled promise rejection inside an async route
// handler does NOT reach the Express error middleware above — it becomes an
// unhandled rejection at the Node process level, and by default that crashes
// the entire process, taking down every concurrent user's session at once
// (confirmed during Module 13 integration testing: a single request with a
// malformed :id parameter did exactly this). These handlers stop that
// failure mode. They are a safety net, not a substitute for validating input
// and wrapping every route handler properly — that deeper fix (an
// asyncHandler wrapper applied across every route file) is a larger
// mechanical pass not yet fully done; this net is what makes that acceptable
// to defer rather than an active production risk.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection (request likely left hanging, but the server stays up):', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception (server stays up):', err);
});

const PORT = process.env.PORT || 3000;
initSchema()
  .then(() => {
    app.listen(PORT, () => console.log(`Mill Line running on port ${PORT}`));
  })
  .catch(err => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
