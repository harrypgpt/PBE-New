import { FOUNDATION_STAGE, WORKSPACE_NAME } from '../src/index';

describe('@pbe/science-core placeholder', () => {
  it('exports its workspace name', () => {
    expect(WORKSPACE_NAME).toBe('@pbe/science-core');
  });

  it('is at the Stage 1 foundation level', () => {
    expect(FOUNDATION_STAGE).toBe(1);
  });
});
