codeunit 50131 "Demo Payment Tests"
{
    Subtype = Test;

    // FailsOnZeroPayments runs first (declaration order == execution order in the AL test
    // runner) so its break-on-error pause gives the debugger session a live tenant/company
    // context before SplitsEvenly's file/line breakpoint is registered — see demos/DEMO.md.
    [Test]
    procedure FailsOnZeroPayments()
    var
        DemoPaymentSplit: Codeunit "Demo Payment Split";
        TotalAmount: Decimal;
        Payments: Integer;
    begin
        TotalAmount := 2500.75;
        Payments := 0;
        DemoPaymentSplit.SplitAmount(TotalAmount, Payments);
    end;

    [Test]
    procedure SplitsEvenly()
    var
        DemoPaymentSplit: Codeunit "Demo Payment Split";
        PerPayment: Decimal;
    begin
        PerPayment := DemoPaymentSplit.SplitAmount(1200, 4);
        if PerPayment <> 300 then
            Error('Expected 300, got %1', PerPayment);
    end;
}
