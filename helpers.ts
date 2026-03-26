import type { ERLCClient } from './client.js';
import type {
  ERLCServerPlayer,
  ERLCCommandLog,
  ERLCKillLog,
  ERLCJoinLog,
  ERLCModCallLog,
} from './types.js';

interface PlayerFormat {
  Name: string;
  ID: string;
}

interface ServerStats {
  current: {
    players: number;
    maxPlayers: number;
    name: string;
    owner: string;
  };
  recent: {
    joins: number;
    kills: number;
    commands: number;
    modCalls: number;
    uniquePlayers: number;
  };
}

export class PRCHelpers {
  private client: any;

  constructor(client: ERLCClient | any) {
    this.client = client;
  }

  async findPlayer(nameOrId: string): Promise<ERLCServerPlayer | null> {
    const data = await this.client.getServer({ Players: true });
    const players = data?.Players || [];
    const lowerQuery = String(nameOrId || '').toLowerCase();
    if (!lowerQuery) return null;

    return (
      players.find((p: ERLCServerPlayer) =>
        String(p.Player || '')
          .toLowerCase()
          .includes(lowerQuery)
      ) || null
    );
  }

  async getPlayersByTeam(team: string): Promise<ERLCServerPlayer[]> {
    const data = await this.client.getServer({ Players: true });
    const players = data?.Players || [];
    const lowerTeam = String(team || '').toLowerCase();
    return players.filter(
      (p: ERLCServerPlayer) => String(p.Team || '').toLowerCase() === lowerTeam
    );
  }

  async getStaffPlayers(): Promise<ERLCServerPlayer[]> {
    const data = await this.client.getServer({ Players: true });
    const players = data?.Players || [];
    return players.filter(
      (p: ERLCServerPlayer) => p.Permission && p.Permission !== 'Normal'
    );
  }

  async getOnlineCount(): Promise<number> {
    const status = await this.client.getServerStatus();
    return status.CurrentPlayers;
  }

  async isServerFull(): Promise<boolean> {
    const status = await this.client.getServerStatus();
    return status.CurrentPlayers >= status.MaxPlayers;
  }

  async sendMessage(message: string): Promise<void> {
    await this.client.executeCommand(`:h ${message}`);
  }

  async sendPM(player: string, message: string): Promise<void> {
    await this.client.executeCommand(`:pm ${player} ${message}`);
  }

  async kickPlayer(player: string, reason?: string): Promise<void> {
    const cmd = reason ? `:kick ${player} ${reason}` : `:kick ${player}`;
    await this.client.executeCommand(cmd);
  }

  async banPlayer(player: string, reason?: string): Promise<void> {
    const cmd = reason ? `:ban ${player} ${reason}` : `:ban ${player}`;
    await this.client.executeCommand(cmd);
  }

  async teleportPlayer(player: string, target: string): Promise<void> {
    await this.client.executeCommand(`:tp ${player} ${target}`);
  }

  async getRecentJoins(minutes: number = 10): Promise<ERLCJoinLog[]> {
    const data = await this.client.getServer({ JoinLogs: true });
    const logs = data?.JoinLogs || [];
    const cutoff = Date.now() / 1000 - minutes * 60;
    return logs.filter(
      (log: ERLCJoinLog) => log.Join && log.Timestamp > cutoff
    );
  }

  async getRecentLeaves(minutes: number = 10): Promise<ERLCJoinLog[]> {
    const data = await this.client.getServer({ JoinLogs: true });
    const logs = data?.JoinLogs || [];
    const cutoff = Date.now() / 1000 - minutes * 60;
    return logs.filter(
      (log: ERLCJoinLog) => !log.Join && log.Timestamp > cutoff
    );
  }

  async getPlayerKills(
    player: string,
    hours: number = 1
  ): Promise<ERLCKillLog[]> {
    const data = await this.client.getServer({ KillLogs: true });
    const logs = data?.KillLogs || [];
    const cutoff = Date.now() / 1000 - hours * 3600;
    const lowerPlayer = String(player || '').toLowerCase();
    return logs.filter(
      (log: ERLCKillLog) =>
        String(log.Killer || '')
          .toLowerCase()
          .includes(lowerPlayer) && log.Timestamp > cutoff
    );
  }

  async getPlayerDeaths(
    player: string,
    hours: number = 1
  ): Promise<ERLCKillLog[]> {
    const data = await this.client.getServer({ KillLogs: true });
    const logs = data?.KillLogs || [];
    const cutoff = Date.now() / 1000 - hours * 3600;
    const lowerPlayer = String(player || '').toLowerCase();
    return logs.filter(
      (log: ERLCKillLog) =>
        String(log.Killed || '')
          .toLowerCase()
          .includes(lowerPlayer) && log.Timestamp > cutoff
    );
  }

  async getPlayerCommands(
    player: string,
    hours: number = 1
  ): Promise<ERLCCommandLog[]> {
    const data = await this.client.getServer({ CommandLogs: true });
    const logs = data?.CommandLogs || [];
    const cutoff = Date.now() / 1000 - hours * 3600;
    const lowerPlayer = String(player || '').toLowerCase();
    return logs.filter(
      (log: ERLCCommandLog) =>
        String(log.Player || '')
          .toLowerCase()
          .includes(lowerPlayer) && log.Timestamp > cutoff
    );
  }

  async getUnansweredModCalls(hours: number = 1): Promise<ERLCModCallLog[]> {
    const data = await this.client.getServer({ ModCalls: true });
    const logs = data?.ModCalls || [];
    const cutoff = Date.now() / 1000 - hours * 3600;
    return logs.filter(
      (log: ERLCModCallLog) => !log.Moderator && log.Timestamp > cutoff
    );
  }

  async waitForPlayer(
    nameOrId: string,
    timeoutMs: number = 30000
  ): Promise<ERLCServerPlayer> {
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      const player = await this.findPlayer(nameOrId);
      if (player) return player;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error(`Player ${nameOrId} not found within timeout`);
  }

  async waitForPlayerCount(
    count: number,
    timeoutMs: number = 60000
  ): Promise<void> {
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      const currentCount = await this.getOnlineCount();
      if (currentCount >= count) return;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    throw new Error(`Server did not reach ${count} players within timeout`);
  }

  formatPlayer(player: string): PlayerFormat {
    const split = String(player || '').split(':');
    if (split.length !== 2) {
      throw new Error(`Invalid player format: ${player}. Expected "Name:ID"`);
    }
    return { Name: split[0], ID: split[1] };
  }

  formatTimestamp(timestamp: number): string {
    return new Date(timestamp * 1000).toLocaleString();
  }

  formatUptime(startTimestamp: number): string {
    const uptimeMs = Date.now() - startTimestamp * 1000;
    const hours = Math.floor(uptimeMs / (1000 * 60 * 60));
    const minutes = Math.floor((uptimeMs % (1000 * 60 * 60)) / (1000 * 60));
    return `${hours}h ${minutes}m`;
  }

  async kickAllFromTeam(team: string, reason?: string): Promise<string[]> {
    const players = await this.getPlayersByTeam(team);
    if (players.length === 0) return [];

    const userNames = players
      .map((p) => {
        try {
          return this.formatPlayer(p.Player).Name;
        } catch {
          return null;
        }
      })
      .filter(Boolean) as string[];

    if (userNames.length > 0) {
      const cmd = reason
        ? `:kick ${userNames.join(',')} ${reason}`
        : `:kick ${userNames.join(',')}`;
      await this.client.executeCommand(cmd);
    }

    return players.map((p) => p.Player);
  }

  async messageAllStaff(message: string): Promise<void> {
    const staff = await this.getStaffPlayers();
    if (staff.length === 0) return;

    const userNames = staff
      .map((p) => {
        try {
          return this.formatPlayer(p.Player).Name;
        } catch {
          return null;
        }
      })
      .filter(Boolean) as string[];

    if (userNames.length > 0) {
      await this.client.executeCommand(`:pm ${userNames.join(',')} ${message}`);
    }
  }

  async getServerStats(hours: number = 24): Promise<ServerStats> {
    const cutoff = Date.now() / 1000 - hours * 3600;

    const status = await this.client.getServer({
      JoinLogs: true,
      KillLogs: true,
      CommandLogs: true,
      ModCalls: true,
    });

    const joinLogs = status.JoinLogs || [];
    const killLogs = status.KillLogs || [];
    const commandLogs = status.CommandLogs || [];
    const modCalls = status.ModCalls || [];

    const recentJoins = joinLogs.filter(
      (log: ERLCJoinLog) => log.Join && log.Timestamp > cutoff
    );
    const recentKills = killLogs.filter(
      (log: ERLCKillLog) => log.Timestamp > cutoff
    );
    const recentCommands = commandLogs.filter(
      (log: ERLCCommandLog) => log.Timestamp > cutoff
    );
    const recentModCalls = modCalls.filter(
      (log: ERLCModCallLog) => log.Timestamp > cutoff
    );

    return {
      current: {
        players: status.CurrentPlayers,
        maxPlayers: status.MaxPlayers,
        name: status.Name,
        owner: status.OwnerId,
      },
      recent: {
        joins: recentJoins.length,
        kills: recentKills.length,
        commands: recentCommands.length,
        modCalls: recentModCalls.length,
        uniquePlayers: new Set(
          recentJoins.map((log: ERLCJoinLog) => log.Player)
        ).size,
      },
    };
  }
}
