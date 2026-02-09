import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { AnchorAmmQ425 } from "../target/types/anchor_amm_q4_25";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { PublicKey, Keypair, SystemProgram } from "@solana/web3.js";
import { assert } from "chai";

describe("anchor-amm-q4-25", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.AnchorAmmQ425 as Program<AnchorAmmQ425>;
  const connection = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;

  // Test accounts
  let mintX: PublicKey;
  let mintY: PublicKey;
  let mintLp: PublicKey;
  let config: PublicKey;
  let vaultX: PublicKey;
  let vaultY: PublicKey;
  let userAtaX: PublicKey;
  let userAtaY: PublicKey;
  let userAtaLp: PublicKey;

  const seed = new BN(1);
  const fee = 100; // 1% fee (100 basis points)

  // Initial token amounts
  const initialMintAmount = 1_000_000_000; // 1000 tokens with 6 decimals

  before(async () => {
    // Create mint X
    mintX = await createMint(
      connection,
      payer,
      payer.publicKey,
      null,
      6 // decimals
    );
    console.log("Mint X created:", mintX.toBase58());

    // Create mint Y
    mintY = await createMint(
      connection,
      payer,
      payer.publicKey,
      null,
      6 // decimals
    );
    console.log("Mint Y created:", mintY.toBase58());

    // Derive PDAs
    [config] = PublicKey.findProgramAddressSync(
      [Buffer.from("config"), seed.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    [mintLp] = PublicKey.findProgramAddressSync(
      [Buffer.from("lp"), config.toBuffer()],
      program.programId
    );

    // Get vault addresses (ATAs owned by config PDA)
    vaultX = anchor.utils.token.associatedAddress({
      mint: mintX,
      owner: config,
    });

    vaultY = anchor.utils.token.associatedAddress({
      mint: mintY,
      owner: config,
    });

    // Create user ATAs and mint tokens
    const userAtaXAccount = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      mintX,
      payer.publicKey
    );
    userAtaX = userAtaXAccount.address;

    const userAtaYAccount = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      mintY,
      payer.publicKey
    );
    userAtaY = userAtaYAccount.address;

    // Mint tokens to user
    await mintTo(
      connection,
      payer,
      mintX,
      userAtaX,
      payer,
      initialMintAmount
    );
    console.log(`Minted ${initialMintAmount} token X to user`);

    await mintTo(
      connection,
      payer,
      mintY,
      userAtaY,
      payer,
      initialMintAmount
    );
    console.log(`Minted ${initialMintAmount} token Y to user`);

    // User LP ATA will be created during deposit
    userAtaLp = anchor.utils.token.associatedAddress({
      mint: mintLp,
      owner: payer.publicKey,
    });
  });

  it("Initialize - creates AMM pool", async () => {
    const tx = await program.methods
      .initialize(seed, fee, null)
      .accountsPartial({
        initializer: payer.publicKey,
        mintX: mintX,
        mintY: mintY,
        mintLp: mintLp,
        vaultX: vaultX,
        vaultY: vaultY,
        config: config,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    console.log("Initialize tx:", tx);

    // Verify config account
    const configAccount = await program.account.config.fetch(config);
    assert.equal(configAccount.seed.toNumber(), seed.toNumber());
    assert.equal(configAccount.fee, fee);
    assert.equal(configAccount.locked, false);
    assert.equal(configAccount.mintX.toBase58(), mintX.toBase58());
    assert.equal(configAccount.mintY.toBase58(), mintY.toBase58());

    console.log("Pool initialized successfully!");
  });

  it("Deposit - adds initial liquidity", async () => {
    const depositAmount = new BN(100_000_000); // 100 tokens worth of LP
    const maxX = new BN(100_000_000); // Max 100 token X
    const maxY = new BN(100_000_000); // Max 100 token Y

    // Get balances before
    const userXBefore = (await getAccount(connection, userAtaX)).amount;
    const userYBefore = (await getAccount(connection, userAtaY)).amount;

    const tx = await program.methods
      .deposit(depositAmount, maxX, maxY)
      .accountsPartial({
        user: payer.publicKey,
        mintX: mintX,
        mintY: mintY,
        config: config,
        mintLp: mintLp,
        vaultX: vaultX,
        vaultY: vaultY,
        userX: userAtaX,
        userY: userAtaY,
        userLp: userAtaLp,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .rpc();

    console.log("Deposit tx:", tx);

    // Verify balances after
    const userXAfter = (await getAccount(connection, userAtaX)).amount;
    const userYAfter = (await getAccount(connection, userAtaY)).amount;
    const userLpAfter = (await getAccount(connection, userAtaLp)).amount;
    const vaultXAfter = (await getAccount(connection, vaultX)).amount;
    const vaultYAfter = (await getAccount(connection, vaultY)).amount;

    console.log(`User X balance: ${userXBefore} -> ${userXAfter}`);
    console.log(`User Y balance: ${userYBefore} -> ${userYAfter}`);
    console.log(`User LP balance: ${userLpAfter}`);
    console.log(`Vault X balance: ${vaultXAfter}`);
    console.log(`Vault Y balance: ${vaultYAfter}`);

    assert.ok(Number(userLpAfter) > 0, "User should have LP tokens");
    assert.ok(Number(vaultXAfter) > 0, "Vault X should have tokens");
    assert.ok(Number(vaultYAfter) > 0, "Vault Y should have tokens");

    console.log("Initial liquidity deposited successfully!");
  });

  it("Deposit - adds more liquidity to existing pool", async () => {
    const depositAmount = new BN(50_000_000); // 50 more LP tokens
    const maxX = new BN(100_000_000);
    const maxY = new BN(100_000_000);

    const userLpBefore = (await getAccount(connection, userAtaLp)).amount;

    const tx = await program.methods
      .deposit(depositAmount, maxX, maxY)
      .accountsPartial({
        user: payer.publicKey,
        mintX: mintX,
        mintY: mintY,
        config: config,
        mintLp: mintLp,
        vaultX: vaultX,
        vaultY: vaultY,
        userX: userAtaX,
        userY: userAtaY,
        userLp: userAtaLp,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .rpc();

    console.log("Second deposit tx:", tx);

    const userLpAfter = (await getAccount(connection, userAtaLp)).amount;
    console.log(`User LP balance: ${userLpBefore} -> ${userLpAfter}`);

    assert.ok(
      Number(userLpAfter) > Number(userLpBefore),
      "User should have more LP tokens"
    );

    console.log("Additional liquidity deposited successfully!");
  });

  it("Swap - swaps token X for token Y", async () => {
    const swapAmount = new BN(10_000_000); // Swap 10 token X
    const minOut = new BN(1); // Minimum 1 token Y out (for testing)

    const userXBefore = (await getAccount(connection, userAtaX)).amount;
    const userYBefore = (await getAccount(connection, userAtaY)).amount;
    const vaultXBefore = (await getAccount(connection, vaultX)).amount;
    const vaultYBefore = (await getAccount(connection, vaultY)).amount;

    const tx = await program.methods
      .swap(true, swapAmount, minOut) // is_x = true means swapping X for Y
      .accountsPartial({
        user: payer.publicKey,
        mintX: mintX,
        mintY: mintY,
        config: config,
        mintLp: mintLp,
        vaultX: vaultX,
        vaultY: vaultY,
        userX: userAtaX,
        userY: userAtaY,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .rpc();

    console.log("Swap X->Y tx:", tx);

    const userXAfter = (await getAccount(connection, userAtaX)).amount;
    const userYAfter = (await getAccount(connection, userAtaY)).amount;
    const vaultXAfter = (await getAccount(connection, vaultX)).amount;
    const vaultYAfter = (await getAccount(connection, vaultY)).amount;

    console.log(`User X: ${userXBefore} -> ${userXAfter}`);
    console.log(`User Y: ${userYBefore} -> ${userYAfter}`);
    console.log(`Vault X: ${vaultXBefore} -> ${vaultXAfter}`);
    console.log(`Vault Y: ${vaultYBefore} -> ${vaultYAfter}`);

    assert.ok(
      Number(userXAfter) < Number(userXBefore),
      "User X balance should decrease"
    );
    assert.ok(
      Number(userYAfter) > Number(userYBefore),
      "User Y balance should increase"
    );
    assert.ok(
      Number(vaultXAfter) > Number(vaultXBefore),
      "Vault X should increase"
    );
    assert.ok(
      Number(vaultYAfter) < Number(vaultYBefore),
      "Vault Y should decrease"
    );

    console.log("Swap X -> Y completed successfully!");
  });

  it("Swap - swaps token Y for token X", async () => {
    const swapAmount = new BN(5_000_000); // Swap 5 token Y
    const minOut = new BN(1); // Minimum 1 token X out

    const userXBefore = (await getAccount(connection, userAtaX)).amount;
    const userYBefore = (await getAccount(connection, userAtaY)).amount;

    const tx = await program.methods
      .swap(false, swapAmount, minOut) // is_x = false means swapping Y for X
      .accountsPartial({
        user: payer.publicKey,
        mintX: mintX,
        mintY: mintY,
        config: config,
        mintLp: mintLp,
        vaultX: vaultX,
        vaultY: vaultY,
        userX: userAtaX,
        userY: userAtaY,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .rpc();

    console.log("Swap Y->X tx:", tx);

    const userXAfter = (await getAccount(connection, userAtaX)).amount;
    const userYAfter = (await getAccount(connection, userAtaY)).amount;

    console.log(`User X: ${userXBefore} -> ${userXAfter}`);
    console.log(`User Y: ${userYBefore} -> ${userYAfter}`);

    assert.ok(
      Number(userXAfter) > Number(userXBefore),
      "User X balance should increase"
    );
    assert.ok(
      Number(userYAfter) < Number(userYBefore),
      "User Y balance should decrease"
    );

    console.log("Swap Y -> X completed successfully!");
  });

  it("Withdraw - removes liquidity from pool", async () => {
    const userLpBefore = (await getAccount(connection, userAtaLp)).amount;
    const withdrawAmount = new BN(Number(userLpBefore) / 2); // Withdraw half of LP tokens
    const minX = new BN(1); // Minimum tokens to receive
    const minY = new BN(1);

    const userXBefore = (await getAccount(connection, userAtaX)).amount;
    const userYBefore = (await getAccount(connection, userAtaY)).amount;
    const vaultXBefore = (await getAccount(connection, vaultX)).amount;
    const vaultYBefore = (await getAccount(connection, vaultY)).amount;

    const tx = await program.methods
      .withdraw(withdrawAmount, minX, minY)
      .accountsPartial({
        user: payer.publicKey,
        mintX: mintX,
        mintY: mintY,
        config: config,
        mintLp: mintLp,
        vaultX: vaultX,
        vaultY: vaultY,
        userX: userAtaX,
        userY: userAtaY,
        userLp: userAtaLp,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .rpc();

    console.log("Withdraw tx:", tx);

    const userXAfter = (await getAccount(connection, userAtaX)).amount;
    const userYAfter = (await getAccount(connection, userAtaY)).amount;
    const userLpAfter = (await getAccount(connection, userAtaLp)).amount;
    const vaultXAfter = (await getAccount(connection, vaultX)).amount;
    const vaultYAfter = (await getAccount(connection, vaultY)).amount;

    console.log(`User X: ${userXBefore} -> ${userXAfter}`);
    console.log(`User Y: ${userYBefore} -> ${userYAfter}`);
    console.log(`User LP: ${userLpBefore} -> ${userLpAfter}`);
    console.log(`Vault X: ${vaultXBefore} -> ${vaultXAfter}`);
    console.log(`Vault Y: ${vaultYBefore} -> ${vaultYAfter}`);

    assert.ok(
      Number(userLpAfter) < Number(userLpBefore),
      "User LP balance should decrease"
    );
    assert.ok(
      Number(userXAfter) > Number(userXBefore),
      "User X balance should increase"
    );
    assert.ok(
      Number(userYAfter) > Number(userYBefore),
      "User Y balance should increase"
    );
    assert.ok(
      Number(vaultXAfter) < Number(vaultXBefore),
      "Vault X should decrease"
    );
    assert.ok(
      Number(vaultYAfter) < Number(vaultYBefore),
      "Vault Y should decrease"
    );

    console.log("Liquidity withdrawn successfully!");
  });

  it("Withdraw - removes remaining liquidity", async () => {
    const userLpBefore = (await getAccount(connection, userAtaLp)).amount;
    const withdrawAmount = new BN(Number(userLpBefore)); // Withdraw all remaining LP
    const minX = new BN(1);
    const minY = new BN(1);

    const tx = await program.methods
      .withdraw(withdrawAmount, minX, minY)
      .accountsPartial({
        user: payer.publicKey,
        mintX: mintX,
        mintY: mintY,
        config: config,
        mintLp: mintLp,
        vaultX: vaultX,
        vaultY: vaultY,
        userX: userAtaX,
        userY: userAtaY,
        userLp: userAtaLp,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .rpc();

    console.log("Final withdraw tx:", tx);

    const userLpAfter = (await getAccount(connection, userAtaLp)).amount;
    const vaultXAfter = (await getAccount(connection, vaultX)).amount;
    const vaultYAfter = (await getAccount(connection, vaultY)).amount;

    console.log(`User LP: ${userLpBefore} -> ${userLpAfter}`);
    console.log(`Vault X remaining: ${vaultXAfter}`);
    console.log(`Vault Y remaining: ${vaultYAfter}`);

    assert.equal(Number(userLpAfter), 0, "User should have no LP tokens left");

    console.log("All liquidity withdrawn successfully!");
  });
});
