import TuyaOAuth2Device from '../../lib/TuyaOAuth2Device';
import { ParsedColourData, SettingsEvent, TuyaStatus } from '../../types/TuyaTypes';
import { FAN_CAPABILITIES, FAN_CAPABILITIES_MAPPING, HomeyFanSettings } from './TuyaFanConstants';
import { constIncludes, getFromMap } from '../../lib/TuyaOAuth2Util';
import * as TuyaFanMigrations from '../../lib/migrations/TuyaFanMigrations';
import { TuyaCommand } from '../../types/TuyaApiTypes';

export default class TuyaOAuth2DeviceFan extends TuyaOAuth2Device {
  async onOAuth2Init(): Promise<void> {
    await super.onOAuth2Init();

    for (const [tuyaCapability, capability] of Object.entries(FAN_CAPABILITIES_MAPPING)) {
      if (
        constIncludes(FAN_CAPABILITIES.read_write, tuyaCapability) &&
        this.hasCapability(capability) &&
        this.hasTuyaCapability(tuyaCapability)
      ) {
        this.registerCapabilityListener(capability, value => this.sendCommand({ code: tuyaCapability, value }));
      }
    }

    // fan_speed
    if (this.hasCapability('legacy_fan_speed')) {
      this.registerCapabilityListener('legacy_fan_speed', value => this.sendCommand({ code: 'fan_speed', value }));
    }

    if (this.hasCapability('dim') && this.getStoreValue('tuya_category') === 'fsd') {
      this.registerCapabilityListener('dim', value => this.sendCommand({ code: 'fan_speed', value }));
    }

    // light capabilities
    const lightCapabilities = ['dim.light', 'light_hue', 'light_saturation', 'light_temperature', 'light_mode'].filter(
      lightCapability => this.hasCapability(lightCapability),
    );

    if (lightCapabilities.length > 0) {
      this.registerMultipleCapabilityListener(
        lightCapabilities,
        capabilityValues => this.onCapabilitiesLight(capabilityValues),
        150,
      );
    }
  }

  async performMigrations(): Promise<void> {
    await super.performMigrations();
    await TuyaFanMigrations.performMigrations(this);
  }

  async onTuyaStatus(status: TuyaStatus, changedStatusCodes: string[]): Promise<void> {
    await super.onTuyaStatus(status, changedStatusCodes);

    for (const tuyaCapability in status) {
      const value = status[tuyaCapability];
      const homeyCapability = getFromMap(FAN_CAPABILITIES_MAPPING, tuyaCapability);

      if (
        (constIncludes(FAN_CAPABILITIES.read_write, tuyaCapability) ||
          constIncludes(FAN_CAPABILITIES.read_only, tuyaCapability)) &&
        homeyCapability
      ) {
        await this.safeSetCapabilityValue(homeyCapability, value);
      }

      if (tuyaCapability === 'fan_speed') {
        if (this.getStoreValue('tuya_category') === 'fsd') {
          await this.safeSetCapabilityValue('dim', value);
        } else {
          await this.safeSetCapabilityValue('legacy_fan_speed', value);
        }
      }
    }

    // Light
    const workMode = status['work_mode'] as 'white' | 'colour' | 'colourful' | 'scene' | 'music' | undefined;
    const lightTemp = status['temp_value'] as number | undefined;
    const lightDim = status['bright_value'] as number | undefined;
    const lightColor = status['colour_data'] as ParsedColourData | undefined;

    if (workMode === 'white') {
      await this.safeSetCapabilityValue('light_mode', 'temperature');
    } else if (workMode === 'colour') {
      await this.safeSetCapabilityValue('light_mode', 'color');
    } else {
      await this.safeSetCapabilityValue('light_mode', null);
    }

    if (lightTemp) {
      const specs = this.store.tuya_temperature;
      const light_temperature = (lightTemp - specs.min) / (specs.max - specs.min);
      await this.safeSetCapabilityValue('light_temperature', light_temperature);
    }

    if (lightDim && (workMode === 'white' || workMode === undefined)) {
      const specs = this.store.tuya_brightness;
      const dim = (lightDim - specs.min) / (specs.max - specs.min);
      await this.safeSetCapabilityValue('dim.light', dim);
    }

    if (lightColor) {
      const specs = this.store.tuya_colour;
      const h = (lightColor.h - specs.h.min) / (specs.h.max - specs.h.min);
      const s = (lightColor.s - specs.s.min) / (specs.s.max - specs.s.min);

      await this.safeSetCapabilityValue('light_hue', h);
      await this.safeSetCapabilityValue('light_saturation', s);

      if (workMode === 'colour') {
        const v = (lightColor.v - specs.v.min) / (specs.v.max - specs.v.min);
        await this.safeSetCapabilityValue('dim.light', v);
      }
    }
  }

  async onCapabilitiesLight({
    light_dim = this.getCapabilityValue('dim.light'),
    light_mode = this.getCapabilityValue('light_mode'),
    light_hue = this.getCapabilityValue('light_hue'),
    light_saturation = this.getCapabilityValue('light_saturation'),
    light_temperature = this.getCapabilityValue('light_temperature'),
  }): Promise<void> {
    const commands: TuyaCommand[] = [];

    if (!light_mode) {
      if (this.hasCapability('light_hue')) {
        light_mode = 'color';
      } else {
        light_mode = 'temperature';
      }
    }

    if (this.hasTuyaCapability('work_mode')) {
      commands.push({
        code: 'work_mode',
        value: light_mode === 'color' ? 'colour' : 'white',
      });
    }

    if (light_mode === 'color') {
      const specs = this.store.tuya_colour;
      const h = specs.h.min + light_hue * (specs.h.max - specs.h.min);
      const s = specs.s.min + light_saturation * (specs.s.max - specs.s.min);
      const v = specs.v.min + light_dim * (specs.v.max - specs.v.min);

      commands.push({
        code: 'colour_data',
        value: { h, s, v },
      });
    } else {
      // Dim
      if (light_dim && this.hasTuyaCapability('bright_value')) {
        const specs = this.store.tuya_brightness;
        const brightValue = specs.min + light_dim * (specs.max - specs.min);

        commands.push({
          code: 'bright_value',
          value: brightValue,
        });
      }

      // Temperature
      if (light_temperature && this.hasTuyaCapability('temp_value')) {
        const specs = this.store.tuya_brightness;
        const tempValue = specs.min + light_temperature * (specs.max - specs.min);

        commands.push({
          code: 'temp_value',
          value: tempValue,
        });
      }
    }

    if (commands.length) {
      await this.sendCommands(commands);
    }
  }

  async onSettings(event: SettingsEvent<HomeyFanSettings>): Promise<string | void> {
    if (event.changedKeys.includes('enable_light_support')) {
      if (event.newSettings['enable_light_support']) {
        for (const lightTuyaCapability of ['light', 'switch_led', 'bright_value', 'temp_value'] as const) {
          if (this.hasTuyaCapability(lightTuyaCapability)) {
            const homeyCapability = FAN_CAPABILITIES_MAPPING[lightTuyaCapability];
            if (!this.hasCapability(homeyCapability)) await this.addCapability(homeyCapability);
          }
        }
        if (this.hasTuyaCapability('colour')) {
          if (!this.hasCapability('light_hue')) await this.addCapability('light_hue');
          if (!this.hasCapability('light_saturation')) await this.addCapability('light_saturation');
          if (!this.hasCapability('dim.light')) await this.addCapability('dim.light');
        }
        if (this.hasCapability('light_temperature') && this.hasCapability('light_hue')) {
          if (!this.hasCapability('light_mode')) await this.addCapability('light_mode');
        }
      } else {
        for (const lightCapability of [
          'onoff.light',
          'dim.light',
          'light_mode',
          'light_temperature',
          'light_hue',
          'light_saturation',
        ]) {
          if (this.hasCapability(lightCapability)) await this.removeCapability(lightCapability);
        }
      }
    }
  }
}

module.exports = TuyaOAuth2DeviceFan;
