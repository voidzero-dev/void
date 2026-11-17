import type { CloudContext } from 'void';
import { SourceLink } from '../components/SourceLink.tsx';

export const prerender = false;

export default async function Weather(c: CloudContext) {
  const [location, temperature] = await fetchWeather(c.req.query('location'));

  return (
    <>
      <h1>Current weather in {location?.name || 'Unknown location'}</h1>

      <SourceLink file="pages/weather.server.tsx" />

      <form method="get" action="/weather">
        <label>
          Location{' '}
          <select name="location">
            {hubs.map(({ id, name }) => (
              <option key={id} value={id} selected={id === location?.id}>
                {name}
              </option>
            ))}
          </select>
        </label>{' '}
        <button type="submit">Show</button>
      </form>

      {typeof temperature === 'number' ? (
        <p>Temperature: {temperature} °C</p>
      ) : (
        <p>Weather data is unavailable right now.</p>
      )}

      <p>
        This async component reads the location from the URL and waits for{' '}
        <a href="https://open-meteo.com/">Open-Meteo</a> on the server.
      </p>
    </>
  );
}

const hubs = [
  { id: 'singapore', name: 'Singapore', latitude: 1.29, longitude: 103.85 },
  { id: 'austin', name: 'Austin', latitude: 30.27, longitude: -97.74 },
  { id: 'lisbon', name: 'Lisbon', latitude: 38.72, longitude: -9.14 },
  { id: 'london', name: 'London', latitude: 51.51, longitude: -0.13 },
  { id: 'san-francisco', name: 'San Francisco', latitude: 37.77, longitude: -122.42 },
] as const;

type Location = (typeof hubs)[number];

type WeatherResult = [Location | undefined, number | undefined];

const noData: WeatherResult = [undefined, undefined];

async function fetchWeather(city: string | undefined): Promise<WeatherResult> {
  const location = hubs.find((hub) => hub.id === city) ?? hubs[0];
  if (!location) {
    return noData;
  }

  const forecastUrl = new URL('https://api.open-meteo.com/v1/forecast');
  forecastUrl.searchParams.set('latitude', String(location.latitude));
  forecastUrl.searchParams.set('longitude', String(location.longitude));
  forecastUrl.searchParams.set('current', 'temperature_2m');
  try {
    const response = await fetch(forecastUrl, { signal: AbortSignal.timeout(4000) });
    if (!response.ok) {
      return noData;
    }
    const forecast = (await response.json()) as {
      current?: { temperature_2m?: number };
    };
    return [location, forecast.current?.temperature_2m];
  } catch {
    return noData;
  }
}
