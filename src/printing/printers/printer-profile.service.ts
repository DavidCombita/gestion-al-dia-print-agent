import { AppConfigService } from '../../config/app-config.service';
import { PaperWidth } from '../../shared/contracts';
import { PrinterProfile } from '../contracts/printer-profile';

export class PrinterProfileService {
  constructor(private readonly configService: AppConfigService) {}

  resolveProfile(
    systemName: string,
    fallbackPaperWidth?: PaperWidth,
  ): PrinterProfile {
    const normalizedSystemName = requireSystemName(systemName);
    const config = this.configService.getConfig();
    const configured = config.printerProfiles.find(
      (profile) =>
        profile.systemName.toLocaleLowerCase() ===
        normalizedSystemName.toLocaleLowerCase(),
    );

    if (configured) {
      return cloneProfile(configured);
    }

    return {
      systemName: normalizedSystemName,
      transport: 'WINDOWS_RAW',
      paperWidth: fallbackPaperWidth ?? config.paperWidth,
      raw: {
        codePage: 'CP850',
        cutPaper: true,
        openCashDrawer: false,
      },
      driver: {
        usePrinterDefaultPageSize: true,
      },
    };
  }

  getConfiguredProfiles(): PrinterProfile[] {
    return this.configService.getConfig().printerProfiles.map(cloneProfile);
  }

  saveProfile(profile: PrinterProfile): PrinterProfile {
    const normalized = this.normalizeProfile(profile);
    const current = this.configService.getConfig().printerProfiles;
    const remaining = current.filter(
      (candidate) =>
        candidate.systemName.toLocaleLowerCase() !==
        normalized.systemName.toLocaleLowerCase(),
    );

    const saved = this.configService.saveConfig({
      printerProfiles: [...remaining, normalized],
    });

    return cloneProfile(
      saved.printerProfiles.find(
        (candidate) =>
          candidate.systemName.toLocaleLowerCase() ===
          normalized.systemName.toLocaleLowerCase(),
      ) ?? normalized,
    );
  }

  private normalizeProfile(profile: PrinterProfile): PrinterProfile {
    const systemName = requireSystemName(profile.systemName);
    const charactersPerLine = Number.isFinite(profile.charactersPerLine)
      ? Math.min(80, Math.max(16, Math.trunc(profile.charactersPerLine as number)))
      : undefined;

    return {
      systemName,
      transport:
        profile.transport === 'WINDOWS_DRIVER'
          ? 'WINDOWS_DRIVER'
          : 'WINDOWS_RAW',
      paperWidth: profile.paperWidth === '58mm' ? '58mm' : '80mm',
      charactersPerLine,
      raw: {
        codePage: 'CP850',
        cutPaper: profile.raw?.cutPaper !== false,
        openCashDrawer: profile.raw?.openCashDrawer === true,
      },
      driver: {
        usePrinterDefaultPageSize:
          profile.driver?.usePrinterDefaultPageSize !== false,
      },
    };
  }
}

function requireSystemName(value: string): string {
  const normalized = value.trim();

  if (!normalized) {
    throw new Error('El system name de la impresora es obligatorio.');
  }

  return normalized;
}

function cloneProfile(profile: PrinterProfile): PrinterProfile {
  return {
    ...profile,
    raw: profile.raw ? { ...profile.raw } : undefined,
    driver: profile.driver ? { ...profile.driver } : undefined,
  };
}

