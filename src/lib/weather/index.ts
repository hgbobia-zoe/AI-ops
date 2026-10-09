// Public surface of the weather module.
export { eventWeather, daysUntilDate, type EventWeatherInput, type EventWeatherDeps } from "./weather";
export { classifyWeatherRisk, WEATHER_THRESHOLDS } from "./classify";
export {
  OPEN_METEO_HORIZON_DAYS,
  type Forecast,
  type WeatherResult,
  type WeatherUnavailableStatus,
  type WeatherRisk,
  type WeatherRiskLevel,
  type GeoPoint,
} from "./types";
