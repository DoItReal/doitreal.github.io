# Hotel Career - prototype, in development

**Play it: https://doitreal.github.io/**

You own a one-star hotel and work the front desk yourself. Check guests in,
check them out, and learn every job on the way to running the place.

> **This is an early prototype and is in development.** It is not a finished
> game, it is not for sale, and it takes no money. Add `#dev` to the URL for the
> playtest panel.

## The first five days teach one department each

| Day | Department | The lesson |
| --- | --- | --- |
| 1 | Reception | Have guests, check them in, and check them **out** |
| 2 | Bellboy | Meets them at the door, carries the bags, walks them up |
| 3 | Housekeeping | Without them a room cannot be resold |
| 4 | Maintenance | Without them everything breaks and nothing can be sold |
| 5 | Reservations | When a room comes free, is it occupied the same day? |

The hotel runs on two times, which is where the game lives: check-in from 14:00,
check-out until 12:00. The window between them is the busiest and most fragile
part of the day - departures have to clear, the rooms have to be turned, and the
arrivals are already in the lobby.

## Your privacy

Nothing leaves your device. There are no accounts, no analytics vendor, no
network requests of any kind, and no third-party code. Play state and the
playtest event log live in your browser's `localStorage` and nowhere else -
clearing your site data erases them completely.

## Running it locally

```bash
python -m http.server 8124   # from this directory
# then open http://localhost:8124/
```

No build step and no dependencies - it is plain ES modules.

```
index.html
src/
  engine.js     One day of hands-on work. Pure, seeded, replayable.
  property.js   Everything that survives a day. Pure - `now` is an argument.
  game.js       Presentation only. Owns the wall clock and localStorage.
  domain/       Room, Booking, Calendar, Clock, Progression, Ledger...
```

Built with the operator, who manages hotels and restaurants professionally.
