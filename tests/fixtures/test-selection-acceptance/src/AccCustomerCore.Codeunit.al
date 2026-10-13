codeunit 50901 "Acc Customer Core"
{
    procedure CreditLimitFor(Rating: Integer): Decimal
    begin
        case Rating of
            1:
                exit(10000);
            2:
                exit(5000);
            3:
                exit(1000);
        end;
        exit(0);
    end;

    procedure IsBlockedRating(Rating: Integer): Boolean
    begin
        exit(Rating >= 4);
    end;
}
