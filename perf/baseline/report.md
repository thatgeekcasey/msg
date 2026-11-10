# Ember performance report

2026-10-12 21:07 UTC · commit 5a36f41 · full profile · local wrangler dev, state in /dev/shm

Intel(R) Xeon(R) Processor @ 2.10GHz, 4 cores, 16 GB · Linux 6.18.44-fc-v114 · Node v22.22.0 · wrangler 4.149.0 · workerd 1.20261006.1 · Lighthouse 13.5.0

## Backend

Milliseconds from one client sending a frame to a client receiving the result, through `wrangler dev`.

### Message latency

Two members, one posting 20 messages a second (300 messages). Ack is the sender seeing its own message come back.

| Storage | Ack p50 | p95 | p99 | Delivery p50 | p95 | p99 | Lost |
| --- | --: | --: | --: | --: | --: | --: | --: |
| DO SQLite | 2.8 | 4.8 | 6.4 | 3.1 | 5.2 | 7.1 | 0 |
| D1 | 4.1 | 5.9 | 6.6 | 4.3 | 6.2 | 7.1 | 0 |

### Write throughput

4 members posting as fast as the room acknowledges, 8 messages in flight each (3000 messages).

| Storage | Messages/s | Ack p50 | p95 | p99 | Out of order | Busiest process CPU |
| --- | --: | --: | --: | --: | --: | --: |
| DO SQLite | 1,359 | 13 | 59 | 228 | 0 | 96% |
| D1 | 536 | 57 | 77 | 85 | 0 | 100% |

### Fan-out

One member posting 10 messages a second (100 messages) to everyone else. Last member is how long until the final copy of a message lands.

| Storage | Members | Delivery p50 | p95 | p99 | Last member p50 | p95 | Busiest process CPU | Lost |
| --- | --: | --: | --: | --: | --: | --: | --: | --: |
| DO SQLite | 10 | 4 | 7.2 | 7.8 | 4.1 | 7.2 | 3% | 0 |
| DO SQLite | 100 | 19 | 25 | 28 | 20 | 25 | 12% | 0 |
| DO SQLite | 250 | 47 | 64 | 87 | 50 | 65 | 28% | 0 |
| DO SQLite | 500 | 90 | 118 | 170 | 96 | 122 | 55% | 0 |
| D1 | 10 | 6 | 9 | 17 | 6.1 | 9 | 5% | 0 |
| D1 | 100 | 21 | 27 | 31 | 22 | 29 | 14% | 0 |
| D1 | 250 | 46 | 57 | 79 | 49 | 59 | 30% | 0 |
| D1 | 500 | 91 | 115 | 158 | 97 | 128 | 56% | 0 |

### Room size

One room grown step by step, 8 joins at a time, until p95 time-to-welcome passes 2,000 ms. Presence per join is what the room sends to everyone already in it each time someone joins.

| Storage | Members | Join p50 | p95 | Joins/s | Presence per join | Busiest process CPU | Server memory |
| --- | --: | --: | --: | --: | --: | --: | --: |
| DO SQLite | 100 | 47 | 83 | 70.4 | 154 KB | 70% | 708 MB |
| DO SQLite | 200 | 122 | 192 | 32.2 | 1,089 KB | 85% | 868 MB |
| DO SQLite | 300 | 246 | 372 | 18.2 | 2,982 KB | 92% | 1,021 MB |
| DO SQLite | 400 | 496 | 733 | 11.4 | 5,830 KB | 92% | 1,124 MB |
| DO SQLite | 500 | 708 | 964 | 8.5 | 9,634 KB | 94% | 1,259 MB |
| DO SQLite | 750 | 1,021 | 2,683 | 3.6 | 18,833 KB | 96% | 1,615 MB |
| D1 | 100 | 43 | 102 | 65 | 154 KB | 70% | 714 MB |
| D1 | 200 | 116 | 245 | 30 | 1,089 KB | 85% | 873 MB |
| D1 | 300 | 224 | 368 | 18.5 | 2,982 KB | 91% | 1,037 MB |
| D1 | 400 | 356 | 697 | 11.3 | 5,830 KB | 92% | 1,129 MB |
| D1 | 500 | 543 | 1,030 | 7.6 | 9,634 KB | 94% | 1,265 MB |
| D1 | 750 | 1,081 | 3,550 | 3.3 | 18,833 KB | 96% | 1,615 MB |

DO SQLite stopped: p95 time-to-welcome passed 2000ms at 750 members.

D1 stopped: p95 time-to-welcome passed 2000ms at 750 members.

### History

A room with 2,000 messages: 30 fresh joins (the welcome carries the newest page), then paging back to the start.

| Storage | Welcome p50 | p95 | Page p50 | p95 | p99 |
| --- | --: | --: | --: | --: | --: |
| DO SQLite | 7.5 | 12 | 2 | 2.8 | 4.8 |
| D1 | 9 | 15 | 4.4 | 7.4 | 13 |

## Frontend

Chrome 141.0.7390.37.

### Bundle

JavaScript and CSS: 416 KB raw, 125.3 KB gzip, 108.3 KB brotli.

| File | Raw | Gzip | Brotli |
| --- | --: | --: | --: |
| `assets/index-C6M0BAHg.js` | 374 KB | 117 KB | 101 KB |
| `assets/index-Dnyt8zfK.css` | 42 KB | 8.3 KB | 7.3 KB |
| `ember-icon.png` | 20.5 KB | 20.5 KB | 20.4 KB |
| `index.html` | 0.9 KB | 0.5 KB | 0.4 KB |

### Lighthouse

Cold loads, median of 3. Mobile simulates slow 4G and a 4x slower CPU; desktop a fast connection. The room page loads signed in.

| Page | Form factor | Score | FCP | LCP | TBT | CLS | Speed Index | Transfer |
| --- | --: | --: | --: | --: | --: | --: | --: | --: |
| sign-in | mobile | 99 | 1,518 | 1,552 | 8 | 0 | 1,518 | 148 KB |
| room | mobile | 96 | 1,574 | 1,952 | 189 | 0 | 1,574 | 148 KB |
| sign-in | desktop | 100 | 383 | 393 | 0 | 0 | 383 | 148 KB |
| room | desktop | 100 | 375 | 448 | 0 | 0.001 | 375 | 148 KB |

### Live rendering

A signed-in browser at the bottom of a room while another member posts 20 messages a second (100 per burst). Frame to paint is a message.created frame reaching the page until the frame showing it is painted. Main thread is Chrome's own task time per incoming message.

| CPU | Timeline | Frame to DOM p50 | p95 | Frame to paint p50 | p95 | Main thread per message | Long tasks | Idle main thread | JS heap |
| --- | --: | --: | --: | --: | --: | --: | --: | --: | --: |
| 1x | 50 | 3.3 | 4.4 | 12 | 14 | 9.3 ms | 0 | 1.9 ms/s | 8.6 MB |
| 1x | 1,000 | 9.4 | 13 | 22 | 36 | 28 ms | 0 | 24 ms/s | 45.8 MB |
| 4x | 50 | 16 | 26 | 37 | 62 | 41 ms | 0 | 8.3 ms/s | 11 MB |
| 4x | 1,000 | 111 | 150 | 232 | 279 | 52 ms | 63 | 32 ms/s | 42.7 MB |

Main-thread time per message by kind of work. Other is mostly paint, compositing and garbage collection.

| CPU | Timeline | Script | Style | Layout | Other |
| --- | --: | --: | --: | --: | --: |
| 1x | 50 | 3.7 ms | 0.3 ms | 0.7 ms | 4.6 ms |
| 1x | 1,000 | 12 ms | 0.6 ms | 2.6 ms | 13 ms |
| 4x | 50 | 18 ms | 1.4 ms | 3 ms | 19 ms |
| 4x | 1,000 | 20 ms | 1.3 ms | 5 ms | 26 ms |

| CPU | Room ready | Load older page p50 | p95 |
| --- | --: | --: | --: |
| 1x | 283 ms | 67 | 137 |
| 4x | 1,284 ms | 328 | 491 |

Room ready is navigation start to the newest messages being in the DOM.
