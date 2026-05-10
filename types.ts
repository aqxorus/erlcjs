export interface ERLCServerPlayer {
  Player: string;
  Permission: string;
  Callsign: string | null;
  Team: string;
  Location?: {
    LocationX: number;
    LocationZ: number;
    PostalCode: string;
    StreetName: string;
    BuildingNumber: string;
  };
  WantedStars?: number;
}

export interface ERLCCommandLog {
  Player: string;
  Timestamp: number;
  Command: string;
}

export interface ERLCModCallLog {
  Caller: string;
  Moderator: string | null;
  Timestamp: number;
}

export interface ERLCKillLog {
  Killed: string;
  Timestamp: number;
  Killer: string;
}

export interface ERLCJoinLog {
  Join: boolean;
  Timestamp: number;
  Player: string;
}

export interface ERLCVehicle {
  Texture: string | null;
  Name: string;
  Owner: string;
  Plate: string;
  ColorHex: string;
  ColorName: string;
}

export interface ERLCEmergencyCall {
  Team: string;
  Caller: number;
  Players: number[];
  Position: [number, number];
  StartedAt: number;
  CallNumber: number;
  Description: string;
  PositionDescriptor: string;
}

export interface ERLCStaffData {
  Admins?: Record<string, string>;
  Mods?: Record<string, string>;
  Helpers?: Record<string, string>;
}

export interface ERLCServerDataV2 {
  Name: string;
  OwnerId: number;
  CoOwnerIds: number[];
  CurrentPlayers: number;
  MaxPlayers: number;
  JoinKey: string;
  AccVerifiedReq: string;
  TeamBalance: boolean;
  Players?: ERLCServerPlayer[];
  Staff?: ERLCStaffData;
  JoinLogs?: ERLCJoinLog[];
  Queue?: number[];
  KillLogs?: ERLCKillLog[];
  CommandLogs?: ERLCCommandLog[];
  ModCalls?: ERLCModCallLog[];
  EmergencyCalls?: ERLCEmergencyCall[];
  Vehicles?: ERLCVehicle[];
}

export interface ERLCCommandResponse {
  message: string;
}

export interface V2ServerQueryOptions {
  Players?: boolean;
  Staff?: boolean;
  JoinLogs?: boolean;
  Queue?: boolean;
  KillLogs?: boolean;
  CommandLogs?: boolean;
  ModCalls?: boolean;
  EmergencyCalls?: boolean;
  Vehicles?: boolean;
}

export interface APIError {
  code: number;
  message: string;
  commandId?: string;
}

export interface RateLimit {
  bucket: string;
  limit: number;
  remaining: number;
  reset: Date;
}

export interface CacheConfig {
  enabled: boolean;
  ttl: number;
  staleIfError: boolean;
  maxItems?: number;
  prefix?: string;
  redisUrl?: string;
  redisKeyPrefix?: string;
}

export interface ClientOptions {
  timeout?: number;
  baseURL?: string;
  baseURL2?: string;
  globalKey?: string;
  requestQueue?: RequestQueueConfig;
  cache?: CacheConfig;
  keepAlive?: boolean;
}

export interface MethodOptions {
  cache?: boolean;
  cacheMaxAge?: number;
}

export interface RequestQueueConfig {
  workers: number;
  interval: number;
}

export const EventType = {
  PLAYERS: 'players',
  COMMANDS: 'commands',
  KILLS: 'kills',
  MODCALLS: 'modcalls',
  JOINS: 'joins',
  VEHICLES: 'vehicles',
} as const;

export type EventTypeValue = (typeof EventType)[keyof typeof EventType];

export const ErrorCode = {
  UNKNOWN: 0,
  ROBLOX_ERROR: 1001,
  INTERNAL_ERROR: 1002,
  NO_SERVER_KEY: 2000,
  INVALID_SERVER_KEY_FORMAT: 2001,
  INVALID_SERVER_KEY: 2002,
  INVALID_GLOBAL_KEY: 2003,
  BANNED_SERVER_KEY: 2004,
  INVALID_COMMAND: 3001,
  SERVER_OFFLINE: 3002,
  RATE_LIMITED: 4001,
  RESTRICTED_COMMAND: 4002,
  PROHIBITED_MESSAGE: 4003,
  RESTRICTED_RESOURCE: 9998,
  OUTDATED_MODULE: 9999,
} as const;

export interface EventConfig {
  pollInterval: number;
  bufferSize: number;
  retryOnError: boolean;
  retryInterval: number;
  filterFunc?: (event: any) => boolean;
  includeInitialState: boolean;
  batchEvents: boolean;
  batchWindow: number;
  logErrors: boolean;
  errorHandler?: (error: Error) => void;
  timeFormat: string;
}

export interface PlayerEvent {
  player: ERLCServerPlayer;
  type: 'join' | 'leave';
}

export interface Event {
  type: string;
  data: any;
}

export interface HandlerRegistration {
  playerHandler?: (event: PlayerEvent) => void;
  commandHandler?: (event: ERLCCommandLog) => void;
  killHandler?: (event: ERLCKillLog) => void;
  modCallHandler?: (event: ERLCModCallLog) => void;
  joinHandler?: (event: ERLCJoinLog) => void;
  vehicleHandler?: (event: ERLCVehicle) => void;
}

export function getFriendlyErrorMessage(err: Error | APIError | any): string {
  if (err && typeof err === 'object' && 'code' in err) {
    const apiErr = err as APIError;
    switch (apiErr.code) {
      case 0:
        return 'An unknown error occurred. If this persists, please contact PRC support.';
      case 1001:
        return 'Failed to communicate with the game server. Please try again in a few minutes.';
      case 1002:
        return 'An internal system error occurred. Please try again later.';
      case 2000:
        return 'No server key provided. Please configure your server key.';
      case 2001:
      case 2002:
        return 'Invalid server key. Please check your configuration.';
      case 2003:
        return 'Invalid API key. Please check your configuration.';
      case 2004:
        return 'This server key has been banned from accessing the API.';
      case 3001:
        return 'Invalid command format. Please check your input.';
      case 3002:
        return 'The server is currently offline (no players). Please try again when players are in the server.';
      case 4001:
        return 'You are being rate limited. Please wait a moment and try again.';
      case 4002:
        return 'This command is restricted and cannot be executed.';
      case 4003:
        return "The message you're trying to send contains prohibited content.";
      case 9998:
        return 'Access to this resource is restricted.';
      case 9999:
        return 'The server module is out of date. Please kick all players and try again.';
      default:
        return apiErr.message || 'An unknown error occurred.';
    }
  }
  return err?.message || 'An unknown error occurred.';
}

export function isPrivateServerOfflineError(err: unknown): boolean {
  const inspected = new Set<any>();
  let current: any = err;

  while (current && typeof current === 'object' && !inspected.has(current)) {
    inspected.add(current);

    const code = current.code ?? current?.data?.code;
    const numericCode =
      typeof code === 'string' ? Number.parseInt(code, 10) : code;
    if (numericCode === 3002) {
      return true;
    }

    const message = current.message ?? current?.data?.message;
    if (
      typeof message === 'string' &&
      /server is currently offline/i.test(message)
    ) {
      return true;
    }

    current = current.cause;
  }

  if (typeof err === 'string') {
    return /server is currently offline/i.test(err);
  }

  return false;
}
