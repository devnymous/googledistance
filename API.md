# Google Distance API

JSON HTTP API that returns distance, duration, and route polylines by scraping Google Maps directions.

## Base URL

- Local dev: http://localhost:3000
- Docker (default): http://localhost:3000

## Content Type

- Request: application/json
- Response: application/json

## Endpoints

### POST /distance

Returns the distance and duration for the first route between two coordinates.

Request body:

```json
{
  "source": { "lat": 37.7749, "lng": -122.4194 },
  "destination": { "lat": 34.0522, "lng": -118.2437 }
}
```

Response body:

```json
{
  "source": { "lat": 37.7749, "lng": -122.4194 },
  "destination": { "lat": 34.0522, "lng": -118.2437 },
  "distance": 612.9,
  "duration": "5 hr 52 min"
}
```

Notes:
- `distance` is a number in kilometers. Example: `0.54` means 540 meters.
- `duration` is a human-readable string when available, otherwise `null`.
- If no routes are available or parsing times out, `distance` and `duration` are `null`.

### POST /polyline

Returns the encoded polyline for the first route between two coordinates.

Request body:

```json
{
  "source": { "lat": 37.7749, "lng": -122.4194 },
  "destination": { "lat": 34.0522, "lng": -118.2437 }
}
```

Response body:

```json
{
  "source": { "lat": 37.7749, "lng": -122.4194 },
  "destination": { "lat": 34.0522, "lng": -118.2437 },
  "polyline": {
    "pointCount": 128,
    "encoded": "{polyline-string}"
  }
}
```

Notes:
- `polyline` is `null` if no routes are available or parsing times out.
- `pointCount` is the number of decoded points used to build the polyline.

## Errors

All errors return status `500` and a JSON body:

```json
{ "error": "Invalid coordinates" }
```

Invalid coordinates are returned when any `lat` or `lng` is missing or not a finite number.

## Examples

```bash
curl -sS http://localhost:3000/distance \
  -H "Content-Type: application/json" \
  -d '{"source":{"lat":37.7749,"lng":-122.4194},"destination":{"lat":34.0522,"lng":-118.2437}}'
```

```bash
curl -sS http://localhost:3000/polyline \
  -H "Content-Type: application/json" \
  -d '{"source":{"lat":37.7749,"lng":-122.4194},"destination":{"lat":34.0522,"lng":-118.2437}}'
```

## Environment Variables

- `PORT` (default: 3000): HTTP server port.
- `PREWARM_BROWSER` (default: true): set to `false` to skip browser prewarm on startup.
- `ROUTE_TIMEOUT_MS` (default: 4000): wait time for the Google Maps directions response.
- `ROUTE_CACHE_TTL_MS` (default: 300000): cache duration in milliseconds; set to `0` to disable cache.
- `ROUTE_CACHE_MAX` (default: 500): max number of cached routes.
- `PAGE_POOL_SIZE` (default: 5): number of browser pages to keep in the pool.

## Caching Behavior

Requests are cached by rounded coordinates. Latitude and longitude are rounded to 5 decimal places using a step size of 0.00005, so near-identical coordinates share the same cache entry.
