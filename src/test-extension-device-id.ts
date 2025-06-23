#!/usr/bin/env node

/**
 * Extension Device ID Generation and Storage Tests
 * Tests device ID functionality with mocked Chrome Extension APIs
 */

interface MockStorage {
  [key: string]: any;
}

interface MockChrome {
  storage: {
    local: {
      get: (keys: string[]) => Promise<any>;
      set: (items: any) => Promise<void>;
    };
  };
}

class ExtensionDeviceIdTests {
  private mockStorage: MockStorage = {};
  private mockChrome: MockChrome;

  constructor() {
    this.mockChrome = this.createMockChrome();
    // @ts-ignore
    globalThis.chrome = this.mockChrome;
  }

  private createMockChrome(): MockChrome {
    return {
      storage: {
        local: {
          get: async (keys: string[]) => {
            const result: any = {};
            keys.forEach(key => {
              if (this.mockStorage[key] !== undefined) {
                result[key] = this.mockStorage[key];
              }
            });
            return result;
          },
          set: async (items: any) => {
            Object.assign(this.mockStorage, items);
          }
        }
      }
    };
  }

  // Copy device ID generation logic from Extension
  private generateUUID(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  // Copy device initialization logic from Extension
  private async initDevice(): Promise<string> {
    try {
      // Try to get existing device ID from storage
      const result = await this.mockChrome.storage.local.get(['deviceId']);
      
      if (result.deviceId) {
        console.log('Loaded existing device ID:', result.deviceId);
        return result.deviceId;
      } else {
        // Generate new device ID
        const deviceId = `device-${this.generateUUID()}`;
        await this.mockChrome.storage.local.set({ deviceId });
        console.log('Generated new device ID:', deviceId);
        return deviceId;
      }
    } catch (error: any) {
      console.log('Error initializing device ID:', error.message);
      // Fallback to session-based ID
      return `device-session-${Date.now()}`;
    }
  }

  async runAllTests(): Promise<void> {
    console.log('🧪 Running Extension Device ID Tests...\n');

    await this.testUUIDGeneration();
    await this.testDeviceIdGeneration();
    await this.testDeviceIdPersistence();
    await this.testDeviceIdFormat();
    await this.testStorageFailureHandling();
    await this.testMultipleInitializations();
    
    console.log('\n✅ All Extension Device ID tests completed!');
  }

  async testUUIDGeneration(): Promise<void> {
    console.log('🔧 Testing UUID Generation...');
    
    const uuid1 = this.generateUUID();
    const uuid2 = this.generateUUID();
    
    // Test UUID format (should match UUID v4 pattern)
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    
    if (!uuidPattern.test(uuid1)) {
      throw new Error(`Invalid UUID format: ${uuid1}`);
    }
    
    if (!uuidPattern.test(uuid2)) {
      throw new Error(`Invalid UUID format: ${uuid2}`);
    }
    
    // Test uniqueness
    if (uuid1 === uuid2) {
      throw new Error('UUIDs should be unique');
    }
    
    console.log(`  ✅ Generated valid UUIDs: ${uuid1.substring(0, 13)}... and ${uuid2.substring(0, 13)}...`);
  }

  async testDeviceIdGeneration(): Promise<void> {
    console.log('🔧 Testing Device ID Generation...');
    
    // Clear storage
    this.mockStorage = {};
    
    const deviceId = await this.initDevice();
    
    // Should start with 'device-'
    if (!deviceId.startsWith('device-')) {
      throw new Error(`Device ID should start with 'device-', got: ${deviceId}`);
    }
    
    // Should contain UUID part
    const uuidPart = deviceId.substring(7); // Remove 'device-' prefix
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    
    if (!uuidPattern.test(uuidPart)) {
      throw new Error(`Device ID should contain valid UUID, got: ${deviceId}`);
    }
    
    console.log(`  ✅ Generated valid device ID: ${deviceId}`);
  }

  async testDeviceIdPersistence(): Promise<void> {
    console.log('🔧 Testing Device ID Persistence...');
    
    // Clear storage
    this.mockStorage = {};
    
    // First initialization
    const deviceId1 = await this.initDevice();
    
    // Second initialization (should return same ID)
    const deviceId2 = await this.initDevice();
    
    if (deviceId1 !== deviceId2) {
      throw new Error(`Device ID should persist: ${deviceId1} !== ${deviceId2}`);
    }
    
    // Verify storage
    const stored = this.mockStorage['deviceId'];
    if (stored !== deviceId1) {
      throw new Error(`Storage should contain device ID: ${stored} !== ${deviceId1}`);
    }
    
    console.log(`  ✅ Device ID persisted correctly: ${deviceId1}`);
  }

  async testDeviceIdFormat(): Promise<void> {
    console.log('🔧 Testing Device ID Format...');
    
    // Test multiple generations
    const deviceIds: string[] = [];
    
    for (let i = 0; i < 5; i++) {
      this.mockStorage = {}; // Clear storage for each test
      const deviceId = await this.initDevice();
      deviceIds.push(deviceId);
      
      // Validate format
      if (!deviceId.startsWith('device-')) {
        throw new Error(`Device ID ${i} has invalid prefix: ${deviceId}`);
      }
      
      const length = deviceId.length;
      if (length !== 43) { // 'device-' (7) + UUID (36) = 43
        throw new Error(`Device ID ${i} has invalid length ${length}: ${deviceId}`);
      }
    }
    
    // Test uniqueness
    const uniqueIds = new Set(deviceIds);
    if (uniqueIds.size !== deviceIds.length) {
      throw new Error('Generated device IDs should be unique');
    }
    
    console.log(`  ✅ All device IDs have correct format and are unique`);
  }

  async testStorageFailureHandling(): Promise<void> {
    console.log('🔧 Testing Storage Failure Handling...');
    
    // Mock storage failure
    const originalGet = this.mockChrome.storage.local.get;
    const originalSet = this.mockChrome.storage.local.set;
    
    this.mockChrome.storage.local.get = async () => {
      throw new Error('Storage get failed');
    };
    
    this.mockChrome.storage.local.set = async () => {
      throw new Error('Storage set failed');
    };
    
    const deviceId = await this.initDevice();
    
    // Should fall back to session-based ID
    if (!deviceId.startsWith('device-session-')) {
      throw new Error(`Should generate session-based ID on storage failure: ${deviceId}`);
    }
    
    // Restore original functions
    this.mockChrome.storage.local.get = originalGet;
    this.mockChrome.storage.local.set = originalSet;
    
    console.log(`  ✅ Fallback to session-based ID works: ${deviceId}`);
  }

  async testMultipleInitializations(): Promise<void> {
    console.log('🔧 Testing Multiple Initializations...');
    
    // Clear storage
    this.mockStorage = {};
    
    // Run first initialization to establish a device ID
    const firstDeviceId = await this.initDevice();
    
    // Now run multiple concurrent initializations
    const promises = Array(5).fill(0).map(() => this.initDevice());
    const deviceIds = await Promise.all(promises);
    
    // All should return the same device ID as the first one
    for (const deviceId of deviceIds) {
      if (deviceId !== firstDeviceId) {
        throw new Error(`All initializations should return same ID: ${firstDeviceId}, but got ${deviceId}`);
      }
    }
    
    console.log(`  ✅ Concurrent initializations returned same ID: ${firstDeviceId}`);
  }
}

// Run tests if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const tests = new ExtensionDeviceIdTests();
  tests.runAllTests().catch(console.error);
}

export { ExtensionDeviceIdTests };