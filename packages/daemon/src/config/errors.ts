/**
 * Error types raised by the config loader. They carry enough context that
 * the daemon's startup path can surface a useful message to the operator
 * without leaking secrets.
 */

export type ConfigErrorCode =
  | 'FILE_NOT_FOUND'
  | 'SOPS_NOT_INSTALLED'
  | 'SOPS_DECRYPT_FAILED'
  | 'YAML_PARSE_FAILED'
  | 'SCHEMA_VALIDATION_FAILED';

export class ConfigError extends Error {
  public readonly code: ConfigErrorCode;
  public readonly path: string;
  public readonly details: string | undefined;

  constructor(code: ConfigErrorCode, path: string, message: string, details?: string) {
    super(message);
    this.name = 'ConfigError';
    this.code = code;
    this.path = path;
    this.details = details;
  }
}
