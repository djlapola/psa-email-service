import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';
import emailRoutes from './routes/email.routes';
import domainRoutes from './routes/domain.routes';
import { QueueService } from './services/queue.service';

dotenv.config();

const app = express();
const prisma = new PrismaClient();
const port = process.env.PORT || 4001;

// Initialize queue service
const queueService = new QueueService(prisma);

// Middleware
app.use(cors());

// Raw body for webhook signature verification
app.use('/api/webhooks/resend', express.raw({ type: 'application/json' }));

// JSON body for other routes
app.use(express.json());

// Make prisma and queue available to routes
app.locals.prisma = prisma;
app.locals.queueService = queueService;

// Health check (no auth required)
app.get('/health', async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({
      status: 'healthy',
      service: 'email-service',
      timestamp: new Date().toISOString(),
      queue: {
        size: queueService.getQueueSize(),
        processing: queueService.isProcessing(),
      },
    });
  } catch (error) {
    res.status(503).json({
      status: 'unhealthy',
      service: 'email-service',
      error: 'Database connection failed',
    });
  }
});

// API routes
app.use('/api', emailRoutes);
app.use('/api/domains', domainRoutes);

// Error handling
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully...');
  queueService.stop();
  await prisma.$disconnect();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT received, shutting down gracefully...');
  queueService.stop();
  await prisma.$disconnect();
  process.exit(0);
});

// Start server
app.listen(port, async () => {
  console.log(`Email service running on port ${port}`);
  await queueService.loadPendingEmails();
  queueService.start();
});

export { app, prisma };
