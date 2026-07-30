# Inventory ledger

## Purpose

Quản lý kho mã an toàn mà không lộ plaintext keys.

## Layout

Ledger/table with import action, threshold filter, product/variant grouping.

## Exact hierarchy

Columns: product/variant, available, reserved, delivered, threshold, health, last import.
Import: upload/paste → validate → count preview → encryption confirmation → result.
Never list plaintext keys.


## Mandatory states

loading, empty, healthy, low stock, out of stock, import validating, partial failure, forbidden, plan limited.

## Mobile 390px

Record list. Counts large enough to scan. Import as full-screen drawer/page.

## Acceptance criteria

- No plaintext inventory key in DOM, log, analytics, screenshot fixture.
- Threshold warnings link to product/import action.
