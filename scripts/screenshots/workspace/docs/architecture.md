# Architecture

The storefront is a React app that talks to the orders API through `src/api`.
The cart lives in `src/cart.ts`, and checkout checks it again before an order
is placed.

- `src/components`: the cart drawer and the product cards.
- `src/utils`: prices and small helpers.
- `tests`: the cart and checkout rules.
