codeunit 50903 "Acc Customer Validation"
{
    procedure ValidateRating(Rating: Integer)
    begin
        if (Rating < 1) or (Rating > 5) then
            Error('Rating %1 is out of range', Rating);
    end;
}
