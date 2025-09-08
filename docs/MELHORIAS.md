# Comando /reorder
- Permite o usuário mudar a ordem de 1 item na lista de reprodução
- Ele pode reordenar por nome ou posição atual da música
- No caso da posição, o comando deve receber APENAS um número inteiro e saber que é a posição, não nome
- No caso de duas músicas detectadas com mesmo nome o comando deve avisar para escolher uma e evitar fazer reorder até o usuário informar uma string única do nome da música

# Melhorias no /queue
- Hoje ele mostra apenas um número determinado das próximas músicas
- Botões com emoji "NEXT" e "PREVIOUS" que atualiza a mensagem estilo "lista"

# Comando /remove
- Permite o usuário remover 1 item da lista de reprodução ou um range de itens
- Ele pode reordenar por nome ou posição atual da música
- Ele deve usar um range de posições para eliminar vários itens
- No caso da posição, o comando deve receber APENAS um número inteiro e saber que é a posição, não nome
- Teremos 2 campos
    - from (obrigatório): Recebe 1 número inteiro ou nome de música
    - limit (opcional): Mesmo tipo de dado do from, quando recebido o comando sabe que deve remover o numero "limit" de itens a partir do from (incluindo o próprio item de from)
- Mesma ideia, se recebermos uma string ambigua, devemos informar o usuário para que ele retorne uma string absoluta (tanto from, quanto limit)

# Comando /clear
- Limpa toda a fila e entra em modo IDLE, mas sem se desconectar do canal

# Melhorias no /radio
- Hoje temos uma lista de rádios
- Podemos manter os estilos, mas fazer uma pesquisa on demand por uma rádio OU um ranqueamento para tocar apenas uma
- Opção de selecionar "estação", estilo rádios FM/AM mas com nomes de rádios já pré listados e caso receba algum não listado, pesquisamos em alguma API pela estação/nome da rádio
- Rádio deve tocar APENAS uma
- Rádio sobrescreve posições e sempre vai ser a primeira caso o comando seja usado
- Rádio não limpa a lista de reprodução, mas sobrescreve posições
- Rádio pode entrar na lista de já tocadas sem problema, mas nunca entra numa lista de "próximas", pois ela sempre tocara no mesmo momento que for chamada movendo o item em reprodução para reproduzido, ou seja, sobrescrevendo a posição

# Melhorias na mensagem persistente da Musa
- Sugestão de campos após/ao lado o shuffle:
    - (music title) pulada por (usuário) ás 00:00
    - Lista de músicas removidas abaixo da lista de reprodução
- Embeds:
    - Hiperlinks nos nomes das músicas com o link delas para o YouTube
    - Hiperlink pelo ID do canal que está tocando (menção), para fácil acesso por clique dos usuários
    - Botões de emoji na mensagem para (PREVIOUS) (PAUSE) (NEXT)
- Edições:
    - "Já tocaram (6)" está limitado a 6 itens, a lista deve permanecer assim, mas a contagem ao lado do texto deveria ser atualizada