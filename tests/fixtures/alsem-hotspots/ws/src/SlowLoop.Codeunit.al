codeunit 50100 "Slow Loop"
{
    procedure SumLines(CustomerNo: Code[20]): Decimal
    var
        Customer: Record Customer;
        Ledger: Record "Cust. Ledger Entry";
        Total: Decimal;
    begin
        Customer.SetRange("No.", CustomerNo);
        if Customer.FindSet() then
            repeat
                Ledger.SetRange("Customer No.", Customer."No.");
                if Ledger.FindFirst() then
                    Total += Ledger.Amount;
            until Customer.Next() = 0;
        exit(Total);
    end;

    procedure CountNames(): Integer
    var
        Customer: Record Customer;
        Count: Integer;
    begin
        if Customer.FindSet() then
            repeat
                if Customer.Name <> '' then
                    Count += 1;
            until Customer.Next() = 0;
        exit(Count);
    end;

    procedure Unblock()
    var
        Customer: Record Customer;
    begin
        if Customer.FindSet() then
            repeat
                Customer.Blocked := Customer.Blocked::" ";
                Customer.Modify();
            until Customer.Next() = 0;
    end;

    procedure Quiet()
    begin
    end;
}
