export declare const VENDOR_NAME: string;

export interface VendorOptions {
  readonly retries: number;
}

export declare function connect(options: VendorOptions): void;
