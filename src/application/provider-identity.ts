import { Injectable } from '@nestjs/common';

// Ponto de extensão da seção 2. Não valida token: auth não pontua e eu não ia
// inventar tabela de usuário. Quando entrar um IdP, troca essa classe.
@Injectable()
export class ProviderIdentity {
  async assertKnown(_providerId: string): Promise<void> {
    return;
  }
}
