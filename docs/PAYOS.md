# PayOS Integration

Each shop connects its own PayOS channel and receives funds directly. Only a valid signed webhook or direct provider reconciliation can confirm payment. Return URLs, browser query parameters and QR rendering never mark an order paid.

Implementation is scheduled for Phase 4 and must re-check the current PayOS API and signature contract before coding.
