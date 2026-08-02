import { divideRounded, fromMinorUnits, toMinorUnits } from "./accountingMoney";

export type InventoryCostState = {
  quantity: number;
  inventoryValue: string;
  movingAverageCost: string;
};

export function applyStockIn(
  state: InventoryCostState,
  quantity: number,
  unitCost: string,
): InventoryCostState {
  if (!Number.isInteger(quantity) || quantity <= 0) throw new Error("Stock In quantity must be positive");
  const currentValue = toMinorUnits(state.inventoryValue);
  const addedValue = toMinorUnits(unitCost) * BigInt(quantity);
  const newQuantity = state.quantity + quantity;
  const newValue = currentValue + addedValue;
  return {
    quantity: newQuantity,
    inventoryValue: fromMinorUnits(newValue),
    movingAverageCost: fromMinorUnits(divideRounded(newValue, BigInt(newQuantity))),
  };
}

export function applyStockOut(
  state: InventoryCostState,
  quantity: number,
  allowNegative = false,
): InventoryCostState & { unitCostSnapshot: string; valueOut: string } {
  if (!Number.isInteger(quantity) || quantity <= 0) throw new Error("Stock Out quantity must be positive");
  if (!allowNegative && quantity > state.quantity) throw new Error("Insufficient available stock");
  const average = toMinorUnits(state.movingAverageCost);
  const valueOut = average * BigInt(quantity);
  const newQuantity = state.quantity - quantity;
  const newValue = toMinorUnits(state.inventoryValue) - valueOut;
  return {
    quantity: newQuantity,
    inventoryValue: fromMinorUnits(newValue),
    movingAverageCost: newQuantity > 0 ? fromMinorUnits(divideRounded(newValue, BigInt(newQuantity))) : "0.0000",
    unitCostSnapshot: fromMinorUnits(average),
    valueOut: fromMinorUnits(valueOut),
  };
}

export function availableQuantity(onHand: number, reserved: number): number {
  return onHand - reserved;
}
