# ApexCart

ApexCart is an e-commerce backend built with Node.js, TypeScript, MongoDB, Redis, and BullMQ.

The main focus of the project is handling the tricky parts of an e-commerce system such as concurrent inventory updates, payment webhooks, duplicate events, retries, and order state changes.

## What ApexCart does

The basic flow is:

```text
Customer
   |
   v
Order API
   |
   +---- Redis lock
   |
   +---- MongoDB transaction
   |
   v
Pending Order
   |
   v
Payment Gateway
   |
   | webhook
   v
Webhook Handler
   |
   +---- Verify signature
   |
   +---- Check idempotency
   |
   v
BullMQ
   |
   v
Worker
   |
   v
Update Order and Payment
   |
   v
MongoDB
```

The admin side can receive order and inventory updates through WebSockets.

## Why these components are used

### MongoDB

MongoDB stores the main application data such as products, inventory, orders, and payment information.

MongoDB transactions are used when multiple changes need to happen together.

For example, creating an order may involve updating inventory and creating the order record. If something fails in the middle, the transaction can roll everything back.

```text
Start transaction

    Check stock
        |
    Update stock
        |
    Create order
        |
    Commit

If something fails
        |
      Rollback
```

MongoDB needs to run as a replica set for transactions.

## Redis

Redis is mainly used for distributed locking and BullMQ.

Inventory is a good example of where a lock is useful.

Suppose there is only one item left and two customers try to buy it at almost the same time.

Without coordination:

```text
Customer A -> stock = 1
Customer B -> stock = 1

Customer A -> buy
Customer B -> buy
```

Both requests can see the same stock value.

With a Redis lock:

```text
Customer A -> acquire lock -> update stock -> release lock

Customer B -> waits -> check stock -> item unavailable
```

The lock has a TTL so a crashed worker does not hold it forever.

The lock is not used as a replacement for the database transaction. It is used to coordinate concurrent requests.

## Order creation

When a customer creates an order, the API roughly does this:

```text
1. Receive order
2. Acquire inventory lock
3. Check inventory
4. Start MongoDB transaction
5. Reserve inventory
6. Create pending order
7. Commit transaction
8. Create payment intent
9. Release lock
```

The exact ordering can be adjusted depending on the payment flow, but the important part is that inventory changes and order creation are handled consistently.

## Payment webhooks

The application does not trust a payment success message just because it came to the webhook endpoint.

The webhook goes through two important checks.

```text
Payment Gateway
      |
      v
Webhook
      |
      v
Verify Signature
      |
      v
Check Idempotency
      |
      v
Queue Event
      |
      v
Worker
```

### Webhook signature

Payment providers sign webhook requests using a secret shared with the application.

ApexCart verifies that signature before accepting the event.

This prevents someone from simply sending a request that says:

```json
{
  "paymentStatus": "success"
}
```

and having the application trust it.

### Idempotency

Payment providers can send the same webhook more than once.

For example:

```text
payment.success
payment.success
payment.success
```

This can happen because of retries or network problems.

ApexCart keeps an idempotency key for payment events so an already processed event is not processed again.

```text
Webhook
   |
   v
Idempotency key
   |
   +---- Already exists -> Ignore
   |
   +---- New event -> Process
```

This is important for operations such as updating payment status, changing inventory, or triggering refunds.

## BullMQ workers

Webhook processing is moved into a BullMQ queue instead of doing all the work inside the HTTP request.

```text
Webhook
   |
   v
BullMQ
   |
   v
Worker
   |
   v
Process payment
```

This is useful because payment processing can involve database operations or other services that may take time or fail temporarily.

If a worker fails, BullMQ can retry the job.

## Retry handling

A failed job does not necessarily mean something is permanently wrong.

For example, MongoDB or another service might be temporarily unavailable.

BullMQ can retry the job with a delay between attempts.

```text
Attempt 1
   |
   X
   |
   v
Wait

Attempt 2
   |
   X
   |
   v
Wait

Attempt 3
   |
   v
Success
```

An exponential backoff strategy can be used so the system does not continuously retry a failing dependency.

If the job still fails after the configured number of attempts, it can be moved to a dead letter queue.

```text
Worker
   |
   X
Retry
   |
   X
Retry
   |
   X
Retry limit
   |
   v
Dead Letter Queue
```

The DLQ gives the failed event a place to be inspected instead of losing it.

## Order states

Orders have their own lifecycle.

```text
PENDING
   |
   v
PAID
   |
   v
READY_TO_SHIP
   |
   v
DELIVERED
```

Other states such as `CANCELLED` or `FAILED` can be added depending on the workflow.

Payment status is kept separately because payment and fulfillment are not the same thing.

For example, an order can be paid but still waiting to be shipped.

## Real time admin updates

The admin dashboard uses WebSockets for updates such as:

* Order status changes
* Inventory changes
* Payment status
* Low stock notifications

Instead of constantly polling:

```text
GET /orders
GET /orders
GET /orders
GET /orders
```

the server can push an update when something actually changes.

## Order document

An example order looks like this:

```json
{
  "_id": "ord_99a8b712c9",
  "userId": "user_40129",
  "status": "PAID",
  "fulfillmentStatus": "READY_TO_SHIP",
  "items": [
    {
      "productId": "prod_mech_keyboard",
      "quantity": 1,
      "unitPrice": 120.00
    }
  ],
  "financials": {
    "subtotal": 120.00,
    "tax": 10.80,
    "total": 130.80,
    "currency": "USD"
  },
  "paymentDetails": {
    "gateway": "STRIPE",
    "paymentIntentId": "pi_example",
    "idempotencyKey": "idem_example",
    "signatureVerified": true,
    "retryCount": 1
  },
  "createdAt": "2026-08-14T19:45:00.000Z",
  "updatedAt": "2026-08-14T19:45:04.210Z"
}
```

## API

### Create order

```http
POST /api/v1/orders
```

Creates an order after checking inventory and acquiring the required lock.

### Payment webhook

```http
POST /api/v1/payments/webhook
```

Receives payment provider events.

The webhook signature is verified before the event is accepted.

### Inventory

```http
GET /api/v1/admin/inventory
```

Returns inventory information for the admin dashboard.

### Ship order

```http
PATCH /api/v1/admin/orders/:id/ship
```

Moves an eligible order into the shipping workflow.

## Tech stack

| Technology        | Used for                              |
| ----------------- | ------------------------------------- |
| Node.js           | Backend runtime                       |
| TypeScript        | Application code                      |
| Express           | API                                   |
| MongoDB           | Orders, products, inventory, payments |
| Redis             | Distributed locks and queue backend   |
| BullMQ            | Background jobs and retries           |
| WebSockets        | Real time updates                     |
| React             | Admin interface                       |
| Stripe / Razorpay | Payment processing                    |

## Setup

### Requirements

Node.js 20 or newer

Redis 7 or newer

MongoDB 6 or newer

MongoDB should be configured as a replica set because the application uses transactions.

### Clone

```bash
git clone https://github.com/your-username/apexcart-engine.git
cd apexcart-engine
```

### Install

```bash
npm install
```

### Environment

Create a `.env` file:

```env
PORT=4000

MONGO_URI=mongodb://127.0.0.1:27017/apexcart?replicaSet=rs0

REDIS_HOST=127.0.0.1
REDIS_PORT=6379

PAYMENT_GATEWAY_SECRET=your_payment_gateway_secret
WEBHOOK_SIGNING_SECRET=your_webhook_signing_secret
```

### Run

Start MongoDB and Redis first, then:

```bash
npm run dev
```

## Project focus

ApexCart is mainly a project for understanding backend reliability.

The interesting parts are what happens when multiple requests touch the same inventory, when payment events arrive more than once, and when background processing fails.

The project uses transactions, Redis locks, idempotency, queues, retries, and explicit order states to deal with those cases.

## License

This is a personal project.
