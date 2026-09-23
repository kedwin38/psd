import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { PasswordService } from "./password.service";
import { TotpService } from "./totp.service";
import { TokenService } from "./token.service";
import { WebAuthnService } from "./webauthn.service";

@Module({
  imports: [JwtModule.register({})],
  controllers: [AuthController],
  providers: [AuthService, PasswordService, TotpService, TokenService, WebAuthnService],
  exports: [AuthService, TokenService],
})
export class AuthModule {}
