// Test-only entry: `@expunge/runtime/testing`. It is deliberately NOT re-exported from the production entry
// (`@expunge/runtime`); the isolation test forbids that.
export {
  FakeChatModel,
  FAKE_PROVIDER_NAME,
  fakeHang,
  fakeText,
  fakeToolCalls,
  type FakeModelCall,
  type FakePart,
  type FakeTurn,
} from './fake-chat-model.js';
