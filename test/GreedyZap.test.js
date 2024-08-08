const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { expect } = require("chai");
const {
  PROTOCOL_BENEFICIARY,
  getMaxSteps,
  wei,
  MAX_INT_256,
} = require("./utils/test-utils");
const { ethers } = require("hardhat");

const MAX_STEPS = getMaxSteps("mainnet");

const MY_TOKEN = {
  tokenParams: { name: "My token", symbol: "MTK" },
  bondParams: {
    mintRoyalty: 100n, // 1%
    burnRoyalty: 100n, // 1%
    reserveToken: null, // Should be set later
    maxSupply: wei(30), // supply: 100
    stepRanges: [wei(10), wei(20), wei(30)],
    stepPrices: [0n, wei(2), wei(5)],
  },
  mintPredicted: {
    tokensToMint: wei(10),
    ethToBond: wei(20), // 20
    ethRequired: wei(202, 17), // 20.2
    protocolRoyalty: wei(2, 17), // 20 * 0.01 = 0.2
  },
  burnPredicted: {
    tokensToBurn: wei(10),
    ethFromBond: wei(20), // 20
    ethToRefund: wei(1985, 16), // 20 - 0.1 - 0.05 = 19.85
    protocolRoyalty: wei(2, 17), // 20 * 0.01 = 0.2
  },
};

describe("ZapV1 - ERC20", function () {
  async function deployFixtures() {
    const TokenImplementation = await ethers.deployContract("MCV2_Token");
    await TokenImplementation.waitForDeployment();

    const NFTImplementation = await ethers.deployContract("MCV2_MultiToken");
    await NFTImplementation.waitForDeployment();

    const Bond = await ethers.deployContract("MCV2_Bond", [
      TokenImplementation.target,
      NFTImplementation.target,
      PROTOCOL_BENEFICIARY,
      0n,
      MAX_STEPS,
    ]);
    await Bond.waitForDeployment();

    const Weth = await ethers.deployContract("WETH9");
    await Weth.waitForDeployment();

    const Zap = await ethers.deployContract("MCV2_ZapV1", [
      Bond.target,
      Weth.target,
    ]);

    return [Weth, Zap, Bond];
  }
  let Weth, Zap, Bond;
  let owner, alice, bob;
  let tokenParams = MY_TOKEN;

  beforeEach(async function () {
    [Weth, Zap, Bond] = await loadFixture(deployFixtures);
    [owner, alice, bob] = await ethers.getSigners();
    tokenParams.bondParams.reserveToken = Weth.target; // set base token (WETH) address

    const Token = await ethers.getContractFactory("MCV2_Token");

    this.creationTx = await Bond.createToken(
      Object.values(tokenParams.tokenParams),
      Object.values(tokenParams.bondParams)
    );

    this.token = await Token.attach(await Bond.tokens(0));
    this.initialEthBalance = await ethers.provider.getBalance(alice.address);
  });

  describe("mintWithEth", function () {
    beforeEach(async function () {
      await Zap.connect(alice).mintWithEth(
        this.token.target,
        tokenParams.mintPredicted.tokensToMint,
        alice.address,
        { value: tokenParams.mintPredicted.ethRequired }
      );
    });

    it("should mint tokens with ETH", async function () {
      expect(await this.token.balanceOf(alice.address)).to.equal(
        tokenParams.mintPredicted.tokensToMint
      );
    });
    it("should deduct ETH from sender", async function () {
      expect(
        await ethers.provider.getBalance(alice.address)
      ).to.changeEtherBalance(-tokenParams.mintPredicted.ethRequired);
    });

    it("should add WETH to bond", async function () {
      expect(await Weth.balanceOf(Bond.target)).to.equal(
        tokenParams.mintPredicted.ethRequired
      );
    });

    it("should add reserve balance correctly", async function () {
      const tokenBond = await Bond.tokenBond(this.token.target);
      expect(tokenBond.reserveBalance).to.equal(
        tokenParams.mintPredicted.ethToBond
      );
    });

    it("should add whole royalty to the beneficiary", async function () {
      const fees = await Bond.getRoyaltyInfo(PROTOCOL_BENEFICIARY, Weth.target);
      expect(fees[0]).to.equal(tokenParams.mintPredicted.protocolRoyalty);
    });

    describe("burnToEth", function () {
      beforeEach(async function () {
        await this.token.connect(alice).approve(Zap.target, MAX_INT_256);
        await Zap.connect(alice).burnToEth(
          this.token.target,
          tokenParams.burnPredicted.tokensToBurn,
          0,
          bob.address
        );
      });

      it("should burn tokens", async function () {
        expect(await this.token.balanceOf(alice.address)).to.equal(0);
      });

      //TODO: - changeEtherBalance() doesn't work
      it("should add return ETH to the receiver", async function () {
        const bobb = await ethers.provider.getBalance(bob.address);
        console.log(bobb);
        expect(
          await ethers.provider.getBalance(bob.address)
        ).to.changeEtherBalance(tokenParams.burnPredicted.ethToRefund);
      });

      it("should deduct WETH from bond", async function () {
        expect(await Weth.balanceOf(Bond.target)).to.changeEtherBalance(
          -tokenParams.burnPredicted.ethToRefund
        );
      });

      it("should deduct reserve balance correctly", async function () {
        const tokenBond = await Bond.tokenBond(this.token.target);
        expect(tokenBond.reserveBalance).to.equal(0); // - ethFromBond
      });

      it("should add whole royalty to the beneficiary", async function () {
        const protocolFees = await Bond.getRoyaltyInfo(
          PROTOCOL_BENEFICIARY,
          Weth.target
        );
        expect(protocolFees[0]).to.equal(
          tokenParams.mintPredicted.protocolRoyalty +
            tokenParams.burnPredicted.protocolRoyalty
        );
      });
    });
  }); // burnToEth
});
