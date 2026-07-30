# Seller order detail

## Purpose

Cho operator hiểu toàn bộ order, payment, fulfillment và audit để xử lý an toàn.

## Layout

Page header with status and safe actions. Two-column desktop: main detail + side summary/actions.

## Exact hierarchy

Sections: summary, customer, items, payment timeline, fulfillment timeline, messages, notes, audit log.
Primary actions depend on role/state; destructive or override actions separated in danger zone.


## Mandatory states

loading, not found, forbidden, payment pending/verified/failed, fulfillment processing/failed/fulfilled, retrying, suspended.

## Mobile 390px

One column. Payment and fulfillment timelines stacked with independent headings. Sticky safe action only when appropriate.

## Acceptance criteria

- No raw provider payload.
- Stable safe error code.
- Override action audited/idempotent.
- Key value not shown to unauthorized role.
