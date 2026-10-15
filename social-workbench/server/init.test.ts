import { createTestContext } from './test/helpers';
import { all } from './db';
import { applyAdminPasswordReset } from './init';
import { FIXTURE_EMAILS } from './test/fixture';

describe('忘記管理員密碼的救援', () => {
  it('設定 ADMIN_RESET_PASSWORD 後可以用新密碼登入，並留下紀錄', async () => {
    const ctx = await createTestContext();
    expect(await applyAdminPasswordReset(ctx.db, { ADMIN_RESET_PASSWORD: 'new-secret-99', ADMIN_RESET_EMAIL: FIXTURE_EMAILS.admin })).toBe(true);
    await ctx.loginWith(FIXTURE_EMAILS.admin, 'new-secret-99');
    expect(await all(ctx.db, "SELECT id FROM audit_logs WHERE action = 'user.reset_password'")).toHaveLength(1);
  });

  it('太短、未設定或不是管理員都不會重設', async () => {
    const ctx = await createTestContext();
    expect(await applyAdminPasswordReset(ctx.db, {})).toBe(false);
    expect(await applyAdminPasswordReset(ctx.db, { ADMIN_RESET_PASSWORD: 'short', ADMIN_RESET_EMAIL: FIXTURE_EMAILS.admin })).toBe(false);
    expect(await applyAdminPasswordReset(ctx.db, { ADMIN_RESET_PASSWORD: 'new-secret-99', ADMIN_RESET_EMAIL: FIXTURE_EMAILS.opA })).toBe(false);
  });
});
